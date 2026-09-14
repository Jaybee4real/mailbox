import { BRAND, ADDRESS_DOMAINS as BRAND_ADDRESS_DOMAINS } from '@/lib/brand'
import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { Resend } from 'resend'
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

  const role: MailRole = body.role === 'admin' ? 'admin' : 'member'
  const name = body.name?.trim() || null
  const domain = resolveDomain(body.domain)
  if (!domain) return NextResponse.json({ ok: false, error: 'That mail domain is not available' }, { status: 400 })
  const address = existing?.address ?? (await uniqueAddress(body.handle || name || email, domain))

  await createAccount({ email, address, role, name, status: 'pending', invitedBy: inviter.email })

  const token = randomBytes(32).toString('hex')
  await createResetToken(email, token, Date.now() + INVITE_TTL_MS)

  const apiKey = process.env.RESEND_API_KEY
  if (apiKey) {
    const from = (process.env.RESEND_FROM ?? BRAND.supportEmail).replace(/^.*<|>$/g, '')
    const origin = process.env.MAIL_PUBLIC_URL?.replace(/\/$/, '') || new URL(req.url).origin
    const inviteUrl = `${origin}/mail/reset?token=${token}&invite=1`
    const resend = new Resend(apiKey)
    try {
      const { data } = await resend.emails.send({
        from: `${BRAND.name} Mail <${from}>`,
        to: [email],
        subject: `You've been invited to ${BRAND.name} Mail`,
        text: `${inviter.email} invited you to ${BRAND.name} Mail.\n\nSet your password to get started: ${inviteUrl}\n\nThis link expires in 7 days.`,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1A1030;">
          <p style="margin:0 0 12px;color:${BRAND.colors.accent};font-weight:600;">You've been invited to ${BRAND.name} Mail</p>
          <p style="margin:0 0 16px;">${name ? `Hi ${name}, ` : ''}you've been given access to ${BRAND.name} Mail. Set a password to get started.</p>
          <a href="${inviteUrl}" style="display:inline-block;background:${BRAND.colors.accent};color:#fff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:8px;">Set your password</a>
          <p style="margin:16px 0 0;color:#8E84A8;font-size:13px;">This invite link expires in 7 days.</p>
        </div>`,
      })
      if (data?.id) await recordSentMeta(data.id, null, true).catch(() => {})
    } catch (err) {
      console.warn('[mail] invite email failed:', err)
    }
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
