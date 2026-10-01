import { BRAND } from '@/lib/brand'
import { renderActionEmail } from '@/lib/emails'
import { sendMail } from '@/lib/mail-provider'
import { recordSentMeta, setChallengeCode } from '@/lib/mailbox'
import { publicOrigin } from '@/lib/public-url'
import { hashEmailCode, newEmailCode } from '@/lib/two-factor'

export function requestContext(req: Request): { ip: string | null; userAgent: string | null } {
  const forwarded = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
  return { ip: forwarded || req.headers.get('x-real-ip') || null, userAgent: req.headers.get('user-agent') }
}

/** Sends a fresh six-digit code for a challenge; the code itself is never stored. */
export async function sendEmailCode(req: Request, challengeId: string, to: string, purpose: 'signin' | 'enroll'): Promise<void> {
  const code = newEmailCode()
  await setChallengeCode(challengeId, hashEmailCode(challengeId, code))
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`
  const from = (process.env.MAIL_FROM ?? process.env.RESEND_FROM ?? BRAND.supportEmail).replace(/^.*<|>$/g, '').trim()
  const doing = purpose === 'signin' ? 'finish signing in to' : 'turn on email codes for'
  const { id } = await sendMail({
    from,
    fromName: `${BRAND.name} Mail`,
    to: [to],
    subject: `${spaced} is your ${BRAND.name} Mail code`,
    text: `Your code to ${doing} ${BRAND.name} Mail is ${spaced}.\n\nIt expires in 10 minutes. If you did not ask for it, someone has your password — change it.`,
    html: renderActionEmail({
      eyebrow: `${BRAND.name} · Mail`,
      code: spaced,
      recipient: to,
      reason: purpose === 'signin' ? 'because two-step sign-in by email is on for your account' : 'because email codes were requested for your account',
      title: spaced,
      body: `Enter this code to ${doing} ${BRAND.name} Mail. ${BRAND.name} will never ask for it by phone, chat or email.`,
      actionLabel: `Open ${BRAND.name} Mail`,
      actionUrl: `${publicOrigin(req)}/mail`,
      expiry: 'The code expires in 10 minutes and works once.',
      footer: 'Did not ask for this? Someone has your password. Sign in and change it.',
    }),
    // A code in the archive would outlive its purpose in a place other people can read.
    skipArchive: true,
  })
  if (id) await recordSentMeta(id, null, true).catch(() => {})
}
