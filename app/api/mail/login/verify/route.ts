import { NextResponse } from 'next/server'
import { currentFingerprint } from '@/lib/dev-auth'
import { deleteLoginChallenge, getLoginChallenge, recordSignin, reserveChallengeAttempt, totpSecretFor, twoFactorState, clearPinLock } from '@/lib/mailbox'
import { clientKey, peekRateLimit, rateLimit } from '@/lib/rate-limit'
import { attachSession, issueSession } from '@/lib/session'
import { issueMobileSession } from '@/lib/mobile-session'
import { requestContext, signInBody } from '@/lib/signin'
import { nativeClient } from '@/lib/turnstile'
import { EMAIL_CODE_TTL_MS, MAX_CODE_ATTEMPTS, hashEmailCode, isChallengeId, verifyTotp, type SecondFactor } from '@/lib/two-factor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WINDOW_MS = 15 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const WRONG_CODES_PER_IP = 20
const WRONG_CODES_PER_ACCOUNT = 20

const expired = (error = 'That sign-in has expired. Enter your password again.') =>
  NextResponse.json({ ok: false, error, expired: true }, { status: 401 })

export async function POST(req: Request) {
  const { body, refused } = await signInBody(req)
  if (refused) return refused
  const ipKey = clientKey(req, 'login-code')
  const flooded = peekRateLimit(ipKey, WRONG_CODES_PER_IP)
  if (flooded) return flooded
  if (!body) return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })

  const challengeId = body.challenge
  if (!isChallengeId(challengeId)) {
    rateLimit(ipKey, WRONG_CODES_PER_IP, WINDOW_MS)
    return expired()
  }
  const limited = rateLimit(`${ipKey}:${challengeId}`, 20, WINDOW_MS)
  if (limited) return limited

  const challenge = await getLoginChallenge(challengeId)
  if (!challenge || challenge.purpose !== 'signin') {
    rateLimit(ipKey, WRONG_CODES_PER_IP, WINDOW_MS)
    return expired()
  }
  const accountKey = `login-code-account:${challenge.email}`
  const accountLimited = peekRateLimit(accountKey, WRONG_CODES_PER_ACCOUNT)
  if (accountLimited) return accountLimited

  const used = await reserveChallengeAttempt(challenge.id, MAX_CODE_ATTEMPTS)
  if (used === null) {
    await deleteLoginChallenge(challenge.id)
    return expired('Too many wrong codes. Enter your password again.')
  }

  const code = String(body.code ?? '').replace(/\s+/g, '')
  const factors = await twoFactorState(challenge.email)
  let passed = false
  const method: SecondFactor | null = body.method === 'authenticator' || body.method === 'email' ? body.method : null
  if (method === 'authenticator' && factors.authenticator) {
    passed = verifyTotp((await totpSecretFor(challenge.email, 'active')) ?? '', code)
  } else if (method === 'email' && factors.email && challenge.codeHash && challenge.codeSentAt) {
    const fresh = Date.now() - Date.parse(challenge.codeSentAt) < EMAIL_CODE_TTL_MS
    passed = fresh && challenge.codeHash === hashEmailCode(challenge.id, code)
  }

  const context = requestContext(req)
  if (!passed) {
    rateLimit(ipKey, WRONG_CODES_PER_IP, WINDOW_MS)
    rateLimit(accountKey, WRONG_CODES_PER_ACCOUNT, HOUR_MS)
    await recordSignin(challenge.email, { ...context, method, outcome: 'wrong-code' }).catch(() => {})
    if (used >= MAX_CODE_ATTEMPTS) {
      await deleteLoginChallenge(challenge.id)
      return expired('Too many wrong codes. Enter your password again.')
    }
    return NextResponse.json({ ok: false, error: 'That code is not right. Check it and try again.' }, { status: 401 })
  }

  await deleteLoginChallenge(challenge.id)
  await recordSignin(challenge.email, { ...context, method, outcome: 'signed-in' }).catch(() => {})
  await clearPinLock(challenge.email).catch(() => {})
  const token = issueSession(challenge.email, await currentFingerprint(challenge.email))
  return attachSession(NextResponse.json({ ok: true, email: challenge.email, session: Boolean(token),
    ...(nativeClient(req) ? { token: await issueMobileSession(challenge.email, await currentFingerprint(challenge.email), req.headers.get('x-mail-device') ?? 'Vela Mail') } : {}),
  }, { headers: { 'Cache-Control': 'no-store' } }), token)
}
