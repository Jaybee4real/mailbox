import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount, verifyMailAuth } from '@/lib/dev-auth'
import { clearResetTokens, setAccountPassword } from '@/lib/mailbox'
import { hashPassword, passwordProblem } from '@/lib/password'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { attachSession, issueSession, passwordFingerprint } from '@/lib/session'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  // This endpoint verifies the current password, so it is a guessing oracle too.
  const limited = rateLimit(clientKey(req, 'password'), 10, 15 * 60 * 1000)
  if (limited) return limited

  let body: { current?: string; next?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  }

  const current = String(body.current ?? '')
  const next = String(body.next ?? '')

  if (next === current) {
    return NextResponse.json(
      { ok: false, error: 'That is the password you are already using.' },
      { status: 400 },
    )
  }

  const account = await resolveAccount(req)
  if (!account.email) {
    return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })
  }

  const problem = passwordProblem(next, account.email)
  if (problem) {
    return NextResponse.json({ ok: false, error: problem }, { status: 400 })
  }

  // Re-check the current password rather than trusting the session header, so a
  // borrowed unlocked screen cannot be used to take the account over.
  const confirmed = await verifyMailAuth(account.email, current)
  if (!confirmed.ok) {
    return NextResponse.json(
      { ok: false, error: 'That is not your current password.' },
      { status: 403 },
    )
  }

  const passwordHash = await hashPassword(next)
  await setAccountPassword(account.email, passwordHash)
  // Any reset link that was already in flight is now a way back in for whoever asked for it.
  await clearResetTokens(account.email).catch(() => {})

  // Every other signed-in device fails its fingerprint check from here on; this response
  // carries the replacement so the person who made the change stays signed in.
  const session = issueSession(account.email, passwordFingerprint(passwordHash))
  return attachSession(NextResponse.json({ ok: true }), session)
}
