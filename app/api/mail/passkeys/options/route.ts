import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount, verifyMailAuth } from '@/lib/dev-auth'
import { getAccount } from '@/lib/mailbox'
import { registrationOptions } from '@/lib/passkeys'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { signInBody } from '@/lib/signin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status })

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const { body, refused } = await signInBody(req)
  if (refused) return refused
  const limited = rateLimit(clientKey(req, 'passkey-add'), 20, 15 * 60 * 1000)
  if (limited) return limited

  const account = await resolveAccount(req)
  if (!account.email) return fail('Not signed in.', 401)
  // A passkey outlives a password change, so adding one takes the password, not just a session.
  const stored = await getAccount(account.email)
  if (stored?.hasPassword) {
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!password) return fail('Enter your password to add a passkey.', 401)
    const check = await verifyMailAuth(account.email, password)
    if (!check.ok) return fail('That password is not right.', 401)
  }

  const created = await registrationOptions(account)
  if (!created) return fail('This mailbox already has the most passkeys allowed. Remove one first.', 409)
  return NextResponse.json({ ok: true, ...created }, { headers: { 'Cache-Control': 'no-store' } })
}
