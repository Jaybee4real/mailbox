import { BlockedRecipientsError } from '@/lib/blocked'
import { NextResponse } from 'next/server'
import { getLoginChallenge, twoFactorState } from '@/lib/mailbox'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { sendEmailCode } from '@/lib/signin'
import { EMAIL_RESEND_MS, maskEmail } from '@/lib/two-factor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const limited = rateLimit(clientKey(req, 'login-email-code'), 8, 15 * 60 * 1000)
  if (limited) return limited

  let body: { challenge?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  }
  const challenge = await getLoginChallenge(String(body.challenge ?? ''))
  if (!challenge || challenge.purpose !== 'signin') {
    return NextResponse.json({ ok: false, error: 'That sign-in has expired. Enter your password again.', expired: true }, { status: 401 })
  }
  const factors = await twoFactorState(challenge.email)
  if (!factors.email || !factors.recoveryEmail) {
    return NextResponse.json({ ok: false, error: 'Email codes are not turned on for this account.' }, { status: 400 })
  }
  if (challenge.codeSentAt && Date.now() - Date.parse(challenge.codeSentAt) < EMAIL_RESEND_MS) {
    return NextResponse.json({ ok: false, error: 'A code was just sent. Wait a minute before asking for another.' }, { status: 429 })
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
