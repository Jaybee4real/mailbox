import { BRAND, ADDRESS_DOMAINS } from '@/lib/brand'
import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { createResetToken, getAccount, recordSentMeta, setRecoveryEmail } from '@/lib/mailbox'
import { sendMail } from '@/lib/mail-provider'
import { renderActionEmail } from '@/lib/emails'
import { publicOrigin } from '@/lib/public-url'
import { clientKey, rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const identity = await resolveAccount(req)
  const account = await getAccount(identity.email)
  return NextResponse.json({
    ok: true,
    recoveryEmail: account?.recoveryEmail ?? null,
    verified: Boolean(account?.recoveryVerified),
  })
}

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const identity = await resolveAccount(req)
  if (!identity.email) return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 403 })

  const limited = rateLimit(clientKey(req, `recovery:${identity.email}`), 6, 60 * 60 * 1000)
  if (limited) return limited

  let body: { recovery?: string | null }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const recovery = (body.recovery ?? '').trim().toLowerCase()
  if (!recovery) {
    await setRecoveryEmail(identity.email, null)
    return NextResponse.json({ ok: true, recoveryEmail: null, verified: false })
  }
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(recovery)) {
    return NextResponse.json({ ok: false, error: 'That is not an email address we can send to.' }, { status: 400 })
  }
  // A recovery address inside the mailbox it recovers is no recovery at all: the reset
  // link would land in the inbox the person cannot open.
  if (ADDRESS_DOMAINS.includes(recovery.split('@')[1] ?? '')) {
    return NextResponse.json(
      { ok: false, error: `Use an address outside ${BRAND.name} Mail — a locked mailbox cannot receive its own reset link.` },
      { status: 400 },
    )
  }

  await setRecoveryEmail(identity.email, recovery)

  const token = randomBytes(32).toString('hex')
  await createResetToken(identity.email, token, Date.now() + VERIFY_TTL_MS, 'verify-recovery')
  const verifyUrl = `${publicOrigin(req)}/api/mail/recovery/verify?token=${token}`
  const from = (process.env.MAIL_FROM ?? process.env.RESEND_FROM ?? BRAND.supportEmail).replace(/^.*<|>$/g, '').trim()

  try {
    const { id } = await sendMail({
      from,
      fromName: `${BRAND.name} Mail`,
      to: [recovery],
      subject: `Confirm this address for ${BRAND.name} Mail recovery`,
      text: `${identity.email} listed this address as the recovery address for their ${BRAND.name} Mail account.\n\nConfirm it: ${verifyUrl}\n\nThe link expires in 24 hours. Until it is used, no reset can be sent here.`,
      html: renderActionEmail({
        eyebrow: `${BRAND.name} · Mail`,
        accent: BRAND.colors.accent,
        title: 'Confirm your recovery address',
        body: `${identity.email} listed this address as where password resets for their ${BRAND.name} Mail account should go. Confirm it and it becomes the only place a reset link is sent.`,
        actionLabel: 'Confirm this address',
        actionUrl: verifyUrl,
        expiry: 'This link expires in 24 hours.',
        footer: "Didn't expect this? Ignore it — nothing is sent here until the link is used.",
      }),
    })
    if (id) await recordSentMeta(id, null, true).catch(() => {})
  } catch (err) {
    console.error('[mail] recovery verification email failed:', err)
    return NextResponse.json(
      { ok: false, error: 'Saved, but the confirmation email could not be sent', recoveryEmail: recovery, verified: false },
      { status: 502 },
    )
  }

  return NextResponse.json({ ok: true, recoveryEmail: recovery, verified: false })
}
