import { NextResponse } from 'next/server'
import { currentFingerprint, resolveSeat, verifyMailAuth } from '@/lib/dev-auth'
import { createLoginChallenge, recordSignin, twoFactorState, clearPinLock } from '@/lib/mailbox'
import { clientKey, rateLimit, clearRateLimit } from '@/lib/rate-limit'
import { attachSession, issueSession } from '@/lib/session'
import { issueMobileSession } from '@/lib/mobile-session'
import { requestContext, requesterContext, signInBody, withDeviceCookie } from '@/lib/signin'
import { guardRequest, guardSuccess, rateLimitedResponse } from '@/lib/vela'
import { chargeNative, clearNativeAddress, humanCheck, nativeClient, turnstileSiteKey } from '@/lib/turnstile'
import { CHALLENGE_TTL_MS, maskEmail, newChallengeId } from '@/lib/two-factor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Ten attempts per address per fifteen minutes: generous for a typo, useless for a list. */
const MAX_ATTEMPTS = 10
const NATIVE_PER_IP = 20
const MAX_EMAIL_LENGTH = 254
const MAX_PASSWORD_LENGTH = 1024
const WINDOW_MS = 15 * 60 * 1000

export function GET(req: Request) {
  return withDeviceCookie(req, NextResponse.json({ ok: true, turnstile: turnstileSiteKey() }, { headers: { 'cache-control': 'no-store' } }))
}

export async function POST(req: Request) {
  const { body, refused } = await signInBody(req)
  if (refused) return refused
  const email = (typeof body?.email === 'string' ? body.email : '').trim().toLowerCase()
  const password = typeof body?.password === 'string' ? body.password : ''
  const turnstile = typeof body?.turnstile === 'string' ? body.turnstile : req.headers.get('x-turnstile')

  if (!email || !password || email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json({ ok: false, error: 'Enter your email and password.' }, { status: 400 })
  }

  const seat = await resolveSeat(email).catch(() => null)
  const seatKey = seat?.email ?? email
  // Keyed on address as well as caller, so one shared office IP cannot lock
  // everybody out, and a rotating-IP attacker still meets a per-account ceiling.
  const key = `${clientKey(req, 'login')}:${seatKey}`
  const limited = rateLimit(key, MAX_ATTEMPTS, WINDOW_MS)
  if (limited) return limited

  const native = { scope: 'login', email: seatKey, perIp: NATIVE_PER_IP, perAddress: MAX_ATTEMPTS, windowMs: WINDOW_MS }
  const human = await humanCheck(req, turnstile, native)
  if (human) {
    if (seat && human.status === 403) void recordSignin(seat.email, { ...requestContext(req), method: 'password', outcome: 'human-check-failed' }).catch(() => {})
    return human
  }

  const requester = requesterContext(req, seatKey)
  const paused = await guardRequest('sign_in_password', seatKey, requester)
  if (paused) return withDeviceCookie(req, rateLimitedResponse(paused))

  const result = await verifyMailAuth(email, password)
  const context = requestContext(req)
  if (!result.ok) {
    chargeNative(req, native)
    if (seat) void recordSignin(seat.email, { ...context, method: 'password', outcome: 'wrong-password' }).catch(() => {})
    // Deliberately the same message whether the address exists or not, so the
    // response cannot be used to enumerate who has a mailbox here.
    return NextResponse.json({ ok: false, error: 'Email or password is incorrect.' }, { status: 401 })
  }

  clearRateLimit(key)
  clearNativeAddress(native)
  void guardSuccess('sign_in_password', seatKey, requester)
  const identity = result.email ?? email

  const factors = await twoFactorState(identity)
  if (factors.authenticator || factors.email) {
    const challenge = newChallengeId()
    await createLoginChallenge(challenge, identity, 'signin', CHALLENGE_TTL_MS)
    await recordSignin(identity, { ...context, method: 'password', outcome: 'second-step' }).catch(() => {})
    return NextResponse.json({
      ok: false,
      twoFactor: true,
      challenge,
      methods: [...(factors.authenticator ? ['authenticator'] : []), ...(factors.email ? ['email'] : [])],
      emailHint: factors.email && factors.recoveryEmail ? maskEmail(factors.recoveryEmail) : null,
    })
  }

  await recordSignin(identity, { ...context, method: 'password', outcome: 'signed-in' }).catch(() => {})
  await clearPinLock(identity).catch(() => {})

  const token = issueSession(identity, await currentFingerprint(identity))
  return attachSession(NextResponse.json({ ok: true, email: identity, session: Boolean(token),
    ...(nativeClient(req) ? { token: await issueMobileSession(identity, await currentFingerprint(identity), req.headers.get('x-mail-device') ?? 'Vela Mail') } : {}),
  }, { headers: { 'Cache-Control': 'no-store' } }), token)
}
