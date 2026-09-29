import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { clearResetTokens, disableTotp, getAccount, recordSignin, setAccountPassword, setEmailCodes } from '@/lib/mailbox'
import { hashPassword, passwordProblem } from '@/lib/password'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { requestContext } from '@/lib/signin'

export const runtime = 'nodejs'

/** The way back in for somebody who lost their phone or forgot their password: an admin, who can read their mail already. */
export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const actor = await resolveAccount(req)
  if (actor.role !== 'admin') return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 })
  const limited = rateLimit(clientKey(req, 'admin-security'), 30, 60 * 60 * 1000)
  if (limited) return limited

  let body: { email?: string; action?: 'two-step-off' | 'set-password'; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  }
  const email = (body.email ?? '').trim().toLowerCase()
  const account = email ? await getAccount(email) : null
  if (!account) return NextResponse.json({ ok: false, error: 'No such account.' }, { status: 404 })
  const context = requestContext(req)

  if (body.action === 'two-step-off') {
    await disableTotp(email)
    await setEmailCodes(email, false)
    await recordSignin(email, { ...context, method: `admin:${actor.email}`, outcome: 'admin-two-step-off' }).catch(() => {})
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'set-password') {
    const next = String(body.password ?? '')
    const problem = passwordProblem(next, email)
    if (problem) return NextResponse.json({ ok: false, error: problem }, { status: 400 })
    // A new hash changes the session fingerprint, so every device they were signed in on is signed out.
    await setAccountPassword(email, await hashPassword(next))
    await clearResetTokens(email)
    await recordSignin(email, { ...context, method: `admin:${actor.email}`, outcome: 'admin-password' }).catch(() => {})
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 })
}
