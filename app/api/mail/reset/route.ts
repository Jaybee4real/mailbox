import { NextResponse } from 'next/server'
import { hashPassword, passwordProblem } from '@/lib/password'
import { resetPasswordWithToken, resetTokenEmail } from '@/lib/mailbox'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { attachSession, issueSession, passwordFingerprint } from '@/lib/session'
import { signInBody } from '@/lib/signin'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const { body, refused } = await signInBody(req)
  if (refused) return refused
  // A reset token is a bearer credential, so guessing one needs a ceiling like login has.
  const limited = rateLimit(clientKey(req, 'reset'), 10, 15 * 60 * 1000)
  if (limited) return limited

  if (!body) return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })

  const token = String(body.token ?? '').trim()
  const password = String(body.password ?? '')
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
