import { BRAND, ADDRESS_DOMAINS } from '@/lib/brand'
import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { isMailAccount } from '@/lib/dev-auth'
import { createResetToken, getAccount, recordSentMeta } from '@/lib/mailbox'
import { sendMail } from '@/lib/mail-provider'
import { renderActionEmail } from '@/lib/emails'
import { publicOrigin } from '@/lib/public-url'
import { clientKey, rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

const RESET_TTL_MS = 30 * 60 * 1000

/** j••••@outlook.com — enough to recognise the inbox, not enough to learn it. */
function mask(address: string): string {
  const [local, domain] = address.split('@')
  if (!domain) return address
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(3, local.length - 1))}@${domain}`
}

/** Nothing can be mailed to an address this deployment itself hosts and has locked. */
const isOurOwn = (address: string) => ADDRESS_DOMAINS.includes(address.split('@')[1] ?? '')

const ASK_ADMIN = 'No confirmed recovery address is set for that mailbox. Ask an administrator on your company mailbox to reset it for you.'

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
  // An unknown address gets the same answer as a known one with nowhere to send, so the
  // reply still cannot be used to learn who has a mailbox here.
  if (!(await isMailAccount(email))) {
    return NextResponse.json({ ok: true, needsAdmin: true, message: ASK_ADMIN })
  }

  // Where the link can actually be read: the confirmed recovery address first, else the
  // sign-in address when that is somewhere else already. An address inside this mailbox
  // is no use — it is the thing being recovered.
  const account = await getAccount(email)
  const destination =
    account?.recoveryVerified && account.recoveryEmail
      ? account.recoveryEmail
      : !isOurOwn(email)
        ? email
        : null

  if (!destination) {
    return NextResponse.json({ ok: true, needsAdmin: true, message: ASK_ADMIN })
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
      to: [destination],
      subject: `Reset your ${BRAND.name} Mail password`,
      text: `Someone requested a password reset for ${email} on ${BRAND.name} Mail.\n\nSet a new password: ${resetUrl}\n\nThis link expires in 30 minutes. If you didn't request it, ignore this email — your password won't change.`,
      html: renderActionEmail({
        eyebrow: `${BRAND.name} · Mail`,
        accent: BRAND.colors.accent,
        title: 'Reset your password',
        body: `Someone asked to reset the password for ${email} on ${BRAND.name} Mail. Choose a new one below.`,
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

  return NextResponse.json({ ok: true, message: `Reset link sent to ${mask(destination)}.` })
}
