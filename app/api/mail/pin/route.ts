import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount, verifyMailAuth } from '@/lib/dev-auth'
import { pinState, recordPinAttempt, savePin } from '@/lib/mailbox'
import { PIN_MAX_ATTEMPTS, PIN_PATTERN, hashPin, verifyPin } from '@/lib/pin'
import { readMobileSession, revokeMobileDevice } from '@/lib/mobile-session'
import { clientKey, rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error, ...extra }, { status })

async function signedIn(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return { guard }
  const account = await resolveAccount(req)
  if (!account.email) return { guard: fail('Not signed in.', 401) }
  return { email: account.email }
}

async function signOutDevice(req: Request, email: string) {
  const session = await readMobileSession(req).catch(() => null)
  if (session) await revokeMobileDevice(email, session.id).catch(() => {})
}

async function body(req: Request): Promise<{ pin?: string; currentPin?: string; password?: string } | null> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

export async function GET(req: Request) {
  const who = await signedIn(req)
  if (who.guard) return who.guard
  const state = await pinState(who.email)
  return NextResponse.json({ ok: true, set: state.set, locked: state.locked, attemptsLeft: Math.max(0, PIN_MAX_ATTEMPTS - state.failed) })
}

export async function POST(req: Request) {
  const who = await signedIn(req)
  if (who.guard) return who.guard
  const limited = rateLimit(clientKey(req, 'pin'), 30, 15 * 60 * 1000)
  if (limited) return limited
  const input = await body(req)
  const pin = String(input?.pin ?? '')
  const state = await pinState(who.email)
  if (!state.set) return fail('No PIN is set.', 404)
  if (state.locked) return fail('Too many wrong PINs. Sign in again with your password.', 423, { locked: true, attemptsLeft: 0 })
  const ok = verifyPin(pin, state.hash)
  const after = await recordPinAttempt(who.email, ok, PIN_MAX_ATTEMPTS)
  if (ok) return NextResponse.json({ ok: true })
  if (after.locked) await signOutDevice(req, who.email)
  const attemptsLeft = Math.max(0, PIN_MAX_ATTEMPTS - after.failed)
  return fail(after.locked ? 'Too many wrong PINs. Sign in again with your password.' : 'Wrong PIN.', after.locked ? 423 : 401, { locked: after.locked, attemptsLeft })
}

export async function PUT(req: Request) {
  const who = await signedIn(req)
  if (who.guard) return who.guard
  const limited = rateLimit(clientKey(req, 'pin'), 30, 15 * 60 * 1000)
  if (limited) return limited
  const input = await body(req)
  const pin = String(input?.pin ?? '')
  if (!PIN_PATTERN.test(pin)) return fail('The PIN must be 6 digits.')
  const state = await pinState(who.email)
  if (input?.password) {
    const confirmed = await verifyMailAuth(who.email, String(input.password))
    if (!confirmed.ok) return fail('Your password is wrong.', 401)
    await savePin(who.email, hashPin(pin))
    return NextResponse.json({ ok: true })
  }
  if (state.locked) return fail('Too many wrong PINs. Sign in again with your password.', 423, { locked: true })
  if (state.set) {
    const ok = verifyPin(String(input?.currentPin ?? ''), state.hash)
    const after = await recordPinAttempt(who.email, ok, PIN_MAX_ATTEMPTS)
    if (!ok) return fail('Your current PIN is wrong.', after.locked ? 423 : 401, { locked: after.locked, attemptsLeft: Math.max(0, PIN_MAX_ATTEMPTS - after.failed) })
  }
  await savePin(who.email, hashPin(pin))
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const who = await signedIn(req)
  if (who.guard) return who.guard
  const limited = rateLimit(clientKey(req, 'pin'), 30, 15 * 60 * 1000)
  if (limited) return limited
  const input = await body(req)
  const state = await pinState(who.email)
  if (!state.set) return NextResponse.json({ ok: true })
  if (state.locked) return fail('Too many wrong PINs. Sign in again with your password.', 423, { locked: true })
  const ok = verifyPin(String(input?.pin ?? ''), state.hash)
  const after = await recordPinAttempt(who.email, ok, PIN_MAX_ATTEMPTS)
  if (!ok) return fail('Wrong PIN.', after.locked ? 423 : 401, { locked: after.locked, attemptsLeft: Math.max(0, PIN_MAX_ATTEMPTS - after.failed) })
  await savePin(who.email, null)
  return NextResponse.json({ ok: true })
}
