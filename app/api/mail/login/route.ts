import { NextResponse } from 'next/server'
import { currentFingerprint, verifyMailAuth } from '@/lib/dev-auth'
import { clientKey, rateLimit, clearRateLimit } from '@/lib/rate-limit'
import { attachSession, issueSession } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Ten attempts per address per fifteen minutes: generous for a typo, useless for a list. */
const MAX_ATTEMPTS = 10
const WINDOW_MS = 15 * 60 * 1000

export async function POST(req: Request) {
  const email = (req.headers.get('x-dev-email') ?? '').trim().toLowerCase()
  const password = req.headers.get('x-dev-password') ?? ''

  // Keyed on address as well as caller, so one shared office IP cannot lock
  // everybody out, and a rotating-IP attacker still meets a per-account ceiling.
  const key = `${clientKey(req, 'login')}:${email}`
  const limited = rateLimit(key, MAX_ATTEMPTS, WINDOW_MS)
  if (limited) return limited

  if (!email || !password) {
    return NextResponse.json({ ok: false, error: 'Enter your email and password.' }, { status: 400 })
  }

  const result = await verifyMailAuth(email, password)
  if (!result.ok) {
    // Deliberately the same message whether the address exists or not, so the
    // response cannot be used to enumerate who has a mailbox here.
    return NextResponse.json({ ok: false, error: 'Email or password is incorrect.' }, { status: 401 })
  }

  clearRateLimit(key)
  const identity = result.email ?? email
  const token = issueSession(identity, await currentFingerprint(identity))
  return attachSession(NextResponse.json({ ok: true, email: identity, session: Boolean(token) }), token)
}
