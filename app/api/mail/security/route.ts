import { NextResponse } from 'next/server'
import { describeLocation } from '@/lib/client-context'
import { BRAND } from '@/lib/brand'
import { mailAuthGuard, resolveAccount, verifyMailAuth } from '@/lib/dev-auth'
import {
  activateTotp, countChallengeAttempt, createLoginChallenge, deleteLoginChallenge, disableTotp, getLoginChallenge, listSignins,
  setEmailCodes, setTotpPending, totpSecretFor, twoFactorState,
} from '@/lib/mailbox'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { sendEmailCode } from '@/lib/signin'
import {
  CHALLENGE_TTL_MS, EMAIL_CODE_TTL_MS, EMAIL_RESEND_MS, MAX_CODE_ATTEMPTS, describeDevice, hashEmailCode, maskEmail,
  newChallengeId, newTotpSecret, otpauthUri, verifyTotp,
} from '@/lib/two-factor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status })

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  const factors = await twoFactorState(account.email)
  const signins = await listSignins(account.email)
  return NextResponse.json({
    ok: true,
    authenticator: factors.authenticator,
    email: factors.email,
    recoveryEmail: factors.recoveryEmail,
    recoveryVerified: factors.recoveryVerified,
    signins: signins.map(entry => ({ ...entry, device: describeDevice(entry.userAgent ?? ''), location: describeLocation(entry) })),
  })
}

type Action =
  | { action: 'authenticator-start' }
  | { action: 'authenticator-confirm'; code?: string }
  | { action: 'authenticator-off'; password?: string }
  | { action: 'email-start' }
  | { action: 'email-confirm'; challenge?: string; code?: string }
  | { action: 'email-off'; password?: string }

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  // Turning a factor off takes the password, which makes this a guessing oracle too.
  const limited = rateLimit(clientKey(req, 'security'), 20, 15 * 60 * 1000)
  if (limited) return limited

  let body: Action
  try {
    body = await req.json()
  } catch {
    return fail('Invalid request.')
  }
  const account = await resolveAccount(req)
  if (!account.email) return fail('Not signed in.', 401)
  const email = account.email

  if (body.action === 'authenticator-start') {
    const secret = newTotpSecret()
    await setTotpPending(email, secret)
    return NextResponse.json({ ok: true, secret, uri: otpauthUri(account.address ?? email, `${BRAND.name} Mail`, secret) })
  }

  if (body.action === 'authenticator-confirm') {
    const pending = await totpSecretFor(email, 'pending')
    if (!pending) return fail('Start again: the setup expired.')
    if (!verifyTotp(pending, String(body.code ?? ''))) return fail('That code does not match. Use the newest one the app shows.')
    await activateTotp(email)
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'email-start') {
    const factors = await twoFactorState(email)
    if (!factors.recoveryVerified || !factors.recoveryEmail) return fail('Confirm an alternate email first. The codes are sent there.')
    const challenge = newChallengeId()
    await createLoginChallenge(challenge, email, 'enroll-email', CHALLENGE_TTL_MS)
    try {
      await sendEmailCode(req, challenge, factors.recoveryEmail, 'enroll')
    } catch (err) {
      console.error('[mail] enrolment code failed:', err)
      return fail('The code could not be sent. Try again.', 502)
    }
    return NextResponse.json({ ok: true, challenge, sentTo: maskEmail(factors.recoveryEmail), resendAfterMs: EMAIL_RESEND_MS })
  }

  if (body.action === 'email-confirm') {
    const challenge = await getLoginChallenge(String(body.challenge ?? ''))
    if (!challenge || challenge.purpose !== 'enroll-email' || challenge.email !== email.toLowerCase()) {
      return fail('That code has expired. Send a new one.')
    }
    const fresh = challenge.codeSentAt && Date.now() - Date.parse(challenge.codeSentAt) < EMAIL_CODE_TTL_MS
    if (!fresh || challenge.codeHash !== hashEmailCode(challenge.id, String(body.code ?? ''))) {
      if (challenge.attempts + 1 >= MAX_CODE_ATTEMPTS) await deleteLoginChallenge(challenge.id)
      else await countChallengeAttempt(challenge.id)
      return fail('That code is not right. Check it and try again.')
    }
    await deleteLoginChallenge(challenge.id)
    await setEmailCodes(email, true)
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'authenticator-off' || body.action === 'email-off') {
    // Someone at an unlocked screen should not be able to remove the lock.
    const confirmed = await verifyMailAuth(email, String(body.password ?? ''))
    if (!confirmed.ok) return fail('That is not your password.', 403)
    if (body.action === 'authenticator-off') await disableTotp(email)
    else await setEmailCodes(email, false)
    return NextResponse.json({ ok: true })
  }

  return fail('Unknown action.')
}
