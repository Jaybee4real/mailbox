import { NextResponse } from 'next/server'
import { currentFingerprint } from '@/lib/dev-auth'
import { countChallengeAttempt, deleteLoginChallenge, getLoginChallenge, recordSignin, totpSecretFor, twoFactorState } from '@/lib/mailbox'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { attachSession, issueSession } from '@/lib/session'
import { issueMobileSession } from '@/lib/mobile-session'
import { requestContext } from '@/lib/signin'
import { EMAIL_CODE_TTL_MS, MAX_CODE_ATTEMPTS, hashEmailCode, verifyTotp, type SecondFactor } from '@/lib/two-factor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const limited = rateLimit(clientKey(req, 'login-code'), 20, 15 * 60 * 1000)
  if (limited) return limited

  let body: { challenge?: string; method?: SecondFactor; code?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  }
  const challenge = await getLoginChallenge(String(body.challenge ?? ''))
  if (!challenge || challenge.purpose !== 'signin') {
    return NextResponse.json({ ok: false, error: 'That sign-in has expired. Enter your password again.', expired: true }, { status: 401 })
  }

  const code = String(body.code ?? '').replace(/\s+/g, '')
  const factors = await twoFactorState(challenge.email)
  let passed = false
  if (body.method === 'authenticator' && factors.authenticator) {
    passed = verifyTotp((await totpSecretFor(challenge.email, 'active')) ?? '', code)
  } else if (body.method === 'email' && factors.email && challenge.codeHash && challenge.codeSentAt) {
    const fresh = Date.now() - Date.parse(challenge.codeSentAt) < EMAIL_CODE_TTL_MS
    passed = fresh && challenge.codeHash === hashEmailCode(challenge.id, code)
  }

  const context = requestContext(req)
  if (!passed) {
    await countChallengeAttempt(challenge.id)
    await recordSignin(challenge.email, { ...context, method: body.method ?? null, outcome: 'wrong-code' }).catch(() => {})
    if (challenge.attempts + 1 >= MAX_CODE_ATTEMPTS) {
      await deleteLoginChallenge(challenge.id)
      return NextResponse.json({ ok: false, error: 'Too many wrong codes. Enter your password again.', expired: true }, { status: 401 })
    }
    return NextResponse.json({ ok: false, error: 'That code is not right. Check it and try again.' }, { status: 401 })
  }

  await deleteLoginChallenge(challenge.id)
  await recordSignin(challenge.email, { ...context, method: body.method ?? null, outcome: 'signed-in' }).catch(() => {})
  const token = issueSession(challenge.email, await currentFingerprint(challenge.email))
  return attachSession(NextResponse.json({ ok: true, email: challenge.email, session: Boolean(token),
    ...(req.headers.get('x-mail-client') === 'vela-native' ? { token: await issueMobileSession(challenge.email, await currentFingerprint(challenge.email), req.headers.get('x-mail-device') ?? 'Vela Mail') } : {}),
  }, { headers: { 'Cache-Control': 'no-store' } }), token)
}
