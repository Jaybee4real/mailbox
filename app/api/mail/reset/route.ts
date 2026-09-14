import { NextResponse } from 'next/server'
import { hashPassword, passwordProblem } from '@/lib/password'
import { resetPasswordWithToken, resetTokenEmail } from '@/lib/mailbox'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { attachSession, issueSession, passwordFingerprint } from '@/lib/session'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  // A reset token is a bearer credential, so guessing one needs a ceiling like login has.
  const limited = rateLimit(clientKey(req, 'reset'), 10, 15 * 60 * 1000)
  if (limited) return limited

  let body: { token?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const token = (body.token ?? '').trim()
  const password = body.password ?? ''
  if (!token) {
    return NextResponse.json({ ok: false, error: 'Missing reset token' }, { status: 400 })
  }

  // Resolved before the token is spent so a rejected password does not burn the link.
  const owner = await resetTokenEmail(token)
  if (!owner) {
    return NextResponse.json({ ok: false, error: 'This reset link is invalid or has expired' }, { status: 400 })
  }

  const problem = passwordProblem(password, owner)
  if (problem) {
    return NextResponse.json({ ok: false, error: problem }, { status: 400 })
  }

  const passwordHash = await hashPassword(password)
  const email = await resetPasswordWithToken(token, passwordHash)
  if (!email) {
    return NextResponse.json({ ok: false, error: 'This reset link is invalid or has expired' }, { status: 400 })
  }

  const session = issueSession(email, passwordFingerprint(passwordHash))
  return attachSession(NextResponse.json({ ok: true, email }), session)
}
