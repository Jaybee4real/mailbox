import { NextResponse } from 'next/server'
import { clientIp } from './client-context'

export const turnstileSiteKey = (): string | null => process.env.TURNSTILE_SITE_KEY || null

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

export async function humanCheck(req: Request, token: unknown): Promise<NextResponse | null> {
  if (!process.env.TURNSTILE_SECRET_KEY) return null
  if (req.headers.get('x-mail-client') === 'vela-native') return null
  if (typeof token === 'string' && token.length > 0 && token.length < 4096 && (await verified(token, clientIp(req)))) return null
  return NextResponse.json({ ok: false, human: false, error: 'Complete the human check and try again' }, { status: 403 })
}
