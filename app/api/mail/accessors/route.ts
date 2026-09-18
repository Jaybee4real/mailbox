import { BRAND, ADDRESS_DOMAINS as BRAND_ADDRESS_DOMAINS } from '@/lib/brand'
import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { sendMail } from '@/lib/mail-provider'
import { renderActionEmail } from '@/lib/emails'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import {
  listAccounts,
  getAccount,
  getAccountByAddress,
  createAccount,
  updateAccount,
  deleteAccount,
  createResetToken,
  recordSentMeta,
  type MailRole,
} from '@/lib/mailbox'

export const runtime = 'nodejs'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
// Personal addresses live on the already-verified (sending + receiving) Resend domain.
const ADDRESS_DOMAIN = BRAND.domain

/**
 * Every suffix an accessor mailbox may use. Only list domains whose MX actually points at
 * our inbound webhook — a domain we can send as but not receive on would look like a working
 * mailbox and silently drop replies. The default domain always stays first.
 */
const ADDRESS_DOMAINS: string[] = BRAND_ADDRESS_DOMAINS

function resolveDomain(requested?: string): string | null {
  if (!requested) return ADDRESS_DOMAIN
  const wanted = requested.trim().toLowerCase().replace(/^@/, '')
  return ADDRESS_DOMAINS.includes(wanted) ? wanted : null
}

async function requireAdmin(req: Request): Promise<NextResponse | null> {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (account.role !== 'admin') {
    return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 })
  }
  return null
}

function slugifyHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/@.*/, '')
    .replace(/[^a-z0-9.]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 40)
}

async function uniqueAddress(handle: string, domain: string = ADDRESS_DOMAIN): Promise<string> {
  const base = slugifyHandle(handle) || 'user'
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = `${attempt === 0 ? base : `${base}${attempt + 1}`}@${domain}`
    if (!(await getAccountByAddress(candidate))) return candidate
  }
  return `${base}.${randomBytes(3).toString('hex')}@${domain}`
}

export async function GET(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const accessors = await listAccounts()
  return NextResponse.json({ ok: true, accessors, domain: ADDRESS_DOMAIN, domains: ADDRESS_DOMAINS })
}

export async function POST(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const inviter = await resolveAccount(req)

  let body: { email?: string; name?: string; role?: MailRole; handle?: string; domain?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const email = (body.email ?? '').trim().toLowerCase()
  if (!email || !email.includes('@')) {
    return NextResponse.json({ ok: false, error: 'A valid email is required' }, { status: 400 })
  }
  const existing = await getAccount(email)
  if (existing && existing.status === 'active') {
    return NextResponse.json({ ok: false, error: 'That person already has an account' }, { status: 409 })
  }
  if (email === inviter.email || email === inviter.address) {
    return NextResponse.json({ ok: false, error: 'That is your own address' }, { status: 400 })
  }
  // An invite has to reach somebody. Sending it to a mailbox on our own domain that nobody
  // can open yet — the very address this invite would create, most often — posts the link
  // into a box only the new person could read once they had already accepted it.
  const inviteeDomain = email.split('@')[1] ?? ''
  if (ADDRESS_DOMAINS.includes(inviteeDomain)) {
    const holder = await getAccountByAddress(email)
    if (!holder || holder.status !== 'active') {
      return NextResponse.json(
        { ok: false, error: `Nobody can read ${email} yet. Send the invite to an address they already have.` },
        { status: 400 },
      )
    }
  }

  const role: MailRole = body.role === 'admin' ? 'admin' : 'member'
  const name = body.name?.trim() || null
  const domain = resolveDomain(body.domain)
  if (!domain) return NextResponse.json({ ok: false, error: 'That mail domain is not available' }, { status: 400 })
  const address = existing?.address ?? (await uniqueAddress(body.handle || name || email, domain))

  await createAccount({ email, address, role, name, status: 'pending', invitedBy: inviter.email })

  const token = randomBytes(32).toString('hex')
  await createResetToken(email, token, Date.now() + INVITE_TTL_MS)

  const from = (process.env.MAIL_FROM ?? process.env.RESEND_FROM ?? BRAND.supportEmail).replace(/^.*<|>$/g, '').trim()
  const origin = process.env.MAIL_PUBLIC_URL?.replace(/\/$/, '') || new URL(req.url).origin
  const inviteUrl = `${origin}/mail/reset?token=${token}&invite=1`
  try {
    const { id } = await sendMail({
      from,
      fromName: `${BRAND.name} Mail`,
      to: [email],
      subject: `You've been invited to ${BRAND.name} Mail`,
      text: `${inviter.email} invited you to ${BRAND.name} Mail.\n\nSet your password to get started: ${inviteUrl}\n\nThis link expires in 7 days.`,
      html: renderActionEmail({
        eyebrow: `${BRAND.name} · Mail`,
        accent: BRAND.colors.accent,
        title: `You've been invited to ${BRAND.name} Mail`,
        body: `${inviter.email} gave you access to ${BRAND.name} Mail${name ? `, ${name}` : ''}. Set a password to get started.`,
        actionLabel: 'Set your password',
        actionUrl: inviteUrl,
        expiry: 'This invite link expires in 7 days.',
        footer: `You are receiving this because ${inviter.email} invited you.`,
      }),
    })
    if (id) await recordSentMeta(id, null, true).catch(() => {})
  } catch (err) {
    // The account row already exists; say the invite did not go out rather than imply it did.
    console.error('[mail] invite email failed:', err)
    return NextResponse.json({ ok: false, error: 'Account created, but the invite email could not be sent', email, address, role }, { status: 502 })
  }

  return NextResponse.json({ ok: true, email, address, role })
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  let body: { email?: string; role?: MailRole; name?: string | null; handle?: string; domain?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const email = (body.email ?? '').trim().toLowerCase()
  if (!email) return NextResponse.json({ ok: false, error: 'email is required' }, { status: 400 })
  const patch: { role?: MailRole; name?: string | null; address?: string } = {}
  if (body.role) patch.role = body.role === 'admin' ? 'admin' : 'member'
  if (body.name !== undefined) patch.name = body.name?.trim() || null

  if (body.handle !== undefined || body.domain !== undefined) {
    const current = (await getAccount(email))?.address ?? ''
    const handle = slugifyHandle(body.handle ?? current.split('@')[0])
    if (!handle) return NextResponse.json({ ok: false, error: 'Mailbox name is not valid' }, { status: 400 })
    const domain = resolveDomain(body.domain ?? current.split('@')[1])
    if (!domain) return NextResponse.json({ ok: false, error: 'That mail domain is not available' }, { status: 400 })
    const address = `${handle}@${domain}`
    const holder = await getAccountByAddress(address)
    if (holder && holder.email !== email) {
      return NextResponse.json({ ok: false, error: `${address} is already taken` }, { status: 409 })
    }
    patch.address = address
  }

  // Never demote the last remaining admin.
  if (patch.role === 'member') {
    const admins = (await listAccounts()).filter(acc => acc.role === 'admin')
    if (admins.length <= 1 && admins.some(acc => acc.email === email)) {
      return NextResponse.json({ ok: false, error: 'At least one admin is required' }, { status: 400 })
    }
  }
  await updateAccount(email, patch)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const admin = await resolveAccount(req)
  let body: { email?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const email = (body.email ?? '').trim().toLowerCase()
  if (!email) return NextResponse.json({ ok: false, error: 'email is required' }, { status: 400 })
  if (email === admin.email.toLowerCase()) {
    return NextResponse.json({ ok: false, error: "You can't remove your own access" }, { status: 400 })
  }
  const target = await getAccount(email)
  if (target?.role === 'admin') {
    const admins = (await listAccounts()).filter(acc => acc.role === 'admin')
    if (admins.length <= 1) {
      return NextResponse.json({ ok: false, error: 'At least one admin is required' }, { status: 400 })
    }
  }
  await deleteAccount(email)
  return NextResponse.json({ ok: true })
}
