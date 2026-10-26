import { NextResponse } from 'next/server'
import { currentFingerprint } from '@/lib/dev-auth'
import { clearPinLock, getAccount, recordSignin } from '@/lib/mailbox'
import { issueMobileSession } from '@/lib/mobile-session'
import { completeSignin } from '@/lib/passkeys'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { attachSession, issueSession } from '@/lib/session'
import { requestContext, signInBody } from '@/lib/signin'
import { nativeClient } from '@/lib/turnstile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const refusedSignin = () => NextResponse.json({ ok: false, error: 'That passkey could not sign you in. Try again or use your password.' }, { status: 401 })

export async function POST(req: Request) {
  const { body, refused } = await signInBody(req)
  if (refused) return refused
  const limited = rateLimit(clientKey(req, 'passkey-signin'), 30, 15 * 60 * 1000)
  if (limited) return limited
  if (!body) return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })

  const email = await completeSignin(body.challenge, body.response).catch(() => null)
  if (!email) return refusedSignin()
  const account = await getAccount(email)
  if (!account || account.status !== 'active') return refusedSignin()

  await recordSignin(email, { ...requestContext(req), method: 'passkey', outcome: 'signed-in' }).catch(() => {})
  await clearPinLock(email).catch(() => {})
  const fingerprint = await currentFingerprint(email)
  const token = issueSession(email, fingerprint)
  return attachSession(NextResponse.json({ ok: true, email, session: Boolean(token),
    ...(nativeClient(req) ? { token: await issueMobileSession(email, fingerprint, req.headers.get('x-mail-device') ?? 'Vela Mail') } : {}),
  }, { headers: { 'Cache-Control': 'no-store' } }), token)
}
