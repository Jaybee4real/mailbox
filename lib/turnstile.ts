import { NextResponse } from 'next/server'
import { clientIp } from './client-context'
import { clearRateLimit, clientKey, peekRateLimit, rateLimit } from './rate-limit'

export const turnstileSiteKey = (): string | null => process.env.TURNSTILE_SITE_KEY || null

export const NATIVE_CLIENT = 'vela-native'

// Browsers attach Origin and Sec-Fetch-Mode to every fetch POST and a page cannot remove
// them; React Native's networking sends neither. So a request carrying either came from a
// web page, whatever x-mail-client it claims, and is held to Turnstile like any other.
export function nativeClient(req: Request): boolean {
  return req.headers.get('x-mail-client') === NATIVE_CLIENT && !req.headers.has('origin') && !req.headers.has('sec-fetch-mode')
}

export type NativeBudget = { scope: string; email: string; perIp: number; perAddress: number; windowMs: number }

const nativeAddressKey = (native: NativeBudget) => `${native.scope}-native-address:${native.email}`

const nativeKeys = (req: Request, native: NativeBudget) =>
  [[clientKey(req, `${native.scope}-native`), native.perIp], [nativeAddressKey(native), native.perAddress]] as const

/** Counts one attempt against the native budget; the human check itself only reads it. */
export function chargeNative(req: Request, native: NativeBudget): NextResponse | null {
  if (!process.env.TURNSTILE_SECRET_KEY || !nativeClient(req)) return null
  let limited: NextResponse | null = null
  for (const [key, limit] of nativeKeys(req, native)) limited = rateLimit(key, limit, native.windowMs) ?? limited
  return limited
}

export function clearNativeAddress(native: NativeBudget): void {
  clearRateLimit(nativeAddressKey(native))
}

async function verified(token: string, ip: string | null): Promise<boolean> {
  const form = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY ?? '', response: token })
  if (ip) form.set('remoteip', ip)
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(8000),
    })
    const data = (await response.json()) as { success?: boolean }
    return data.success === true
  } catch (error) {
    console.warn('[turnstile] verification unavailable:', error)
    return false
  }
}

export async function humanCheck(req: Request, token: unknown, native: NativeBudget): Promise<NextResponse | null> {
  if (!process.env.TURNSTILE_SECRET_KEY) return null
  if (nativeClient(req)) {
    for (const [key, limit] of nativeKeys(req, native)) {
      const limited = peekRateLimit(key, limit)
      if (limited) return limited
    }
    return null
  }
  if (typeof token === 'string' && token.length > 0 && token.length < 4096 && (await verified(token, clientIp(req)))) return null
  return NextResponse.json({ ok: false, human: false, error: 'Complete the human check and try again' }, { status: 403 })
}
