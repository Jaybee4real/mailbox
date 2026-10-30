import { NextResponse } from 'next/server'
import { velaApiBase, velaApiKey, velaConfigProblem } from './vela-config'

export { velaApiBase, velaApiKey, velaConfigProblem }

export type RequestPurpose =
  | 'login_code'
  | 'password_reset'
  | 'verification'
  | 'email_change'
  | 'invite'
  | 'signup'
  | 'security_notice'
  | 'transactional'
  | 'marketing'

export type GuardAction = 'sign_in_password' | 'verify_code' | 'pin' | 'passkey'

export type RequesterContext = {
  ip?: string | null
  device?: string | null
  account?: string | null
  user_agent?: string | null
}

export type RateLimitScope = 'device' | 'account' | 'ip'

export class VelaRateLimitError extends Error {
  scope: RateLimitScope
  retryAfter: number
  blockedUntil: string

  constructor(input: { message?: string; scope?: unknown; retryAfter?: unknown; blockedUntil?: unknown }) {
    super(input.message || 'Too many requests. Try again shortly.')
    this.name = 'VelaRateLimitError'
    this.scope = input.scope === 'account' || input.scope === 'ip' ? input.scope : 'device'
    const seconds = Number(input.retryAfter)
    this.retryAfter = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60
    const until = Date.parse(String(input.blockedUntil ?? ''))
    this.blockedUntil = new Date(Number.isFinite(until) ? until : Date.now() + this.retryAfter * 1000).toISOString()
  }
}

export function rateLimitedJson(input: { message: string; scope: RateLimitScope; retryAfter: number; blockedUntil?: string }): NextResponse {
  const retryAfter = Math.max(1, Math.ceil(input.retryAfter))
  return NextResponse.json(
    {
      ok: false,
      error: input.message,
      name: 'rate_limited',
      scope: input.scope,
      retry_after: retryAfter,
      blocked_until: input.blockedUntil ?? new Date(Date.now() + retryAfter * 1000).toISOString(),
    },
    { status: 429, headers: { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' } },
  )
}

export const rateLimitedResponse = (error: VelaRateLimitError): NextResponse =>
  rateLimitedJson({ message: error.message, scope: error.scope, retryAfter: error.retryAfter, blockedUntil: error.blockedUntil })

export async function readRateLimit(response: Response): Promise<VelaRateLimitError | null> {
  if (response.status !== 429) return null
  const body = (await response.clone().json().catch(() => ({}))) as Record<string, unknown>
  if (body.name !== 'rate_limited') return null
  return new VelaRateLimitError({
    message: typeof body.message === 'string' ? body.message : undefined,
    scope: body.scope,
    retryAfter: body.retry_after ?? response.headers.get('retry-after'),
    blockedUntil: body.blocked_until,
  })
}

const compact = (context: RequesterContext): RequesterContext =>
  Object.fromEntries(Object.entries(context).filter(([, value]) => typeof value === 'string' && value)) as RequesterContext

async function guardCall(path: string, action: GuardAction, target: string, context: RequesterContext): Promise<Response | null> {
  const key = velaApiKey()
  if (!key || velaConfigProblem()) return null
  try {
    return await fetch(`${velaApiBase()}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action, target: target.trim().toLowerCase(), context: compact(context) }),
      signal: AbortSignal.timeout(3000),
    })
  } catch (err) {
    console.error(`[mail] Vela guard ${path} unreachable:`, err)
    return null
  }
}

export async function guardRequest(action: GuardAction, target: string, context: RequesterContext): Promise<VelaRateLimitError | null> {
  const response = await guardCall('/guard', action, target, context)
  return response ? readRateLimit(response) : null
}

export async function guardSuccess(action: GuardAction, target: string, context: RequesterContext): Promise<void> {
  await guardCall('/guard/success', action, target, context)
}
