import { BlockedRecipientsError } from '@/lib/blocked'
import { NextResponse } from 'next/server'
import { getLoginChallenge, twoFactorState } from '@/lib/mailbox'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { sendEmailCode, signInBody } from '@/lib/signin'
import { EMAIL_RESEND_MS, isChallengeId, maskEmail } from '@/lib/two-factor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WINDOW_MS = 15 * 60 * 1000

export async function POST(req: Request) {
  const { body, refused } = await signInBody(req)
  if (refused) return refused
  const flood = rateLimit(clientKey(req, 'login-email-code'), 40, WINDOW_MS)
  if (flood) return flood
  if (!body) return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })

  const challengeId = body.challenge
  const expired = NextResponse.json({ ok: false, error: 'That sign-in has expired. Enter your password again.', expired: true }, { status: 401 })
  if (!isChallengeId(challengeId)) return expired
  const limited = rateLimit(`${clientKey(req, 'login-email-code')}:${challengeId}`, 8, WINDOW_MS)
  if (limited) return limited

  const challenge = await getLoginChallenge(challengeId)
  if (!challenge || challenge.purpose !== 'signin') return expired
  const factors = await twoFactorState(challenge.email)
  if (!factors.email || !factors.recoveryEmail) {
    return NextResponse.json({ ok: false, error: 'Email codes are not turned on for this account.' }, { status: 400 })
  }
  const sinceSent = challenge.codeSentAt ? Date.now() - Date.parse(challenge.codeSentAt) : Infinity
  if (sinceSent < EMAIL_RESEND_MS) {
    return NextResponse.json(
      { ok: false, error: 'A code was just sent. Wait a minute before asking for another.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((EMAIL_RESEND_MS - sinceSent) / 1000)) } },
    )
  }
  try {
    await sendEmailCode(req, challenge.id, factors.recoveryEmail, 'signin')
  } catch (err) {
    console.error('[mail] sign-in code failed:', err)
    const error = err instanceof BlockedRecipientsError
      ? 'The code could not be sent: your recovery address is blocked because mail to it bounced. Ask an admin to unblock it.'
      : 'The code could not be sent. Try again.'
    return NextResponse.json({ ok: false, error }, { status: 502 })
  }
  return NextResponse.json({ ok: true, sentTo: maskEmail(factors.recoveryEmail) })
}
