import { BRAND } from '@/lib/brand'
import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { isMailAccount } from '@/lib/dev-auth'
import { createResetToken, recordSentMeta } from '@/lib/mailbox'
import { sendMail } from '@/lib/mail-provider'
import { renderActionEmail } from '@/lib/emails'
import { publicOrigin } from '@/lib/public-url'
import { clientKey, rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

const RESET_TTL_MS = 30 * 60 * 1000

export async function POST(req: Request) {
  const limited = rateLimit(clientKey(req, 'request-reset'), 5, 60 * 60 * 1000)
  if (limited) return limited

  let body: { email?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const email = (body.email ?? '').trim().toLowerCase()

  // Also capped per address, so a rotating-IP caller cannot bury someone in reset mail.
  const perAddress = rateLimit(`request-reset-address:${email}`, 5, 60 * 60 * 1000)
  if (perAddress) return NextResponse.json({ ok: true })
  // Always answer ok so we never reveal which addresses are valid accounts.
  if (!(await isMailAccount(email))) {
    return NextResponse.json({ ok: true })
  }

  const token = randomBytes(32).toString('hex')
  await createResetToken(email, token, Date.now() + RESET_TTL_MS)

  const from = (process.env.MAIL_FROM ?? process.env.RESEND_FROM ?? BRAND.supportEmail)
    .replace(/^.*<|>$/g, '')
    .trim()
  const resetUrl = `${publicOrigin(req)}/mail/reset?token=${token}`
  try {
    const { id } = await sendMail({
      from,
      fromName: `${BRAND.name} Mail`,
      to: [email],
      subject: `Reset your ${BRAND.name} Mail password`,
      text: `Someone requested a password reset for ${BRAND.name} Mail.\n\nSet a new password: ${resetUrl}\n\nThis link expires in 30 minutes. If you didn't request it, ignore this email — your password won't change.`,
      html: renderActionEmail({
        eyebrow: `${BRAND.name} · Mail`,
        accent: BRAND.colors.accent,
        title: 'Reset your password',
        body: `Someone asked to reset the password for your ${BRAND.name} Mail account. Choose a new one below.`,
        actionLabel: 'Set a new password',
        actionUrl: resetUrl,
        expiry: 'This link expires in 30 minutes and can be used once.',
        footer: "Didn't request this? Ignore this email — your password will not change.",
      }),
    })
    if (id) await recordSentMeta(id, null, true).catch(() => {})
  } catch (err) {
    // A reset that silently sends nothing is indistinguishable from one that worked.
    console.error('[mail] reset email failed:', err)
    return NextResponse.json({ ok: false, error: 'Could not send the reset email' }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}
