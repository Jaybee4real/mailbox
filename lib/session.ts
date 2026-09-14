import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { NextResponse } from 'next/server'

export const SESSION_COOKIE = 'mp_mail_session'

const MAX_AGE_SECONDS = 14 * 24 * 60 * 60

function secret(): string | null {
  return process.env.MAIL_SESSION_SECRET?.trim() || null
}

/**
 * Binding the token to a digest of the stored password hash is what makes a password
 * change revoke every session that was issued before it, without keeping a session table.
 */
export function passwordFingerprint(passwordHash: string | undefined): string {
  return createHash('sha256').update(passwordHash ?? '').digest('hex').slice(0, 16)
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url')
}

export function issueSession(email: string, fingerprint: string): string | null {
  const key = secret()
  if (!key) return null
  const expires = Date.now() + MAX_AGE_SECONDS * 1000
  const payload = `${Buffer.from(email).toString('base64url')}.${expires}.${fingerprint}`
  return `${payload}.${sign(payload, key)}`
}

export function readSession(req: Request): { email: string; fingerprint: string } | null {
  const key = secret()
  if (!key) return null

  const cookies = req.headers.get('cookie') ?? ''
  const raw = cookies
    .split(';')
    .map(entry => entry.trim())
    .find(entry => entry.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1)
  if (!raw) return null

  const parts = raw.split('.')
  if (parts.length !== 4) return null
  const [encodedEmail, expires, fingerprint, signature] = parts

  const expected = sign(`${encodedEmail}.${expires}.${fingerprint}`, key)
  if (signature.length !== expected.length) return null
  try {
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
  } catch {
    return null
  }

  if (!Number(expires) || Number(expires) <= Date.now()) return null

  const email = Buffer.from(encodedEmail, 'base64url').toString('utf8').trim().toLowerCase()
  if (!email.includes('@')) return null
  return { email, fingerprint }
}

export function attachSession(response: NextResponse, token: string | null): NextResponse {
  if (!token) return response
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL),
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
  return response
}

export function clearSession(response: NextResponse): NextResponse {
  response.cookies.set({ name: SESSION_COOKIE, value: '', httpOnly: true, path: '/', maxAge: 0 })
  return response
}
