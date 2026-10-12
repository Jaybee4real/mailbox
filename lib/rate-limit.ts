import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { clientIp } from './client-context'

type Bucket = { count: number; resetAt: number }

// ponytail: per-instance memory, so a serverless fan-out multiplies the real ceiling by the
// number of warm lambdas. Enough to stop a single-host credential stuffer; move to Turso or
// Upstash if the limit ever needs to be exact.
const buckets = new Map<string, Bucket>()

export function clientKey(req: Request, scope: string): string {
  const address = clientIp(req) ?? 'unknown'
  return `${scope}:${address}`
}

const boundedKey = (key: string) => (key.length > 200 ? createHash('sha256').update(key).digest('hex') : key)

function throttled(resetAt: number, now: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'Too many attempts. Try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(Math.ceil((resetAt - now) / 1000)) } },
  )
}

/** The 429 rateLimit would give once this key is over its limit, without counting this call. */
export function peekRateLimit(key: string, limit: number): NextResponse | null {
  const now = Date.now()
  const bucket = buckets.get(boundedKey(key))
  return bucket && bucket.resetAt > now && bucket.count >= limit ? throttled(bucket.resetAt, now) : null
}

/** Returns a 429 when the caller is over budget, otherwise null. */
export function rateLimit(rawKey: string, limit: number, windowMs: number): NextResponse | null {
  const key = boundedKey(rawKey)
  const now = Date.now()

  if (buckets.size > 5000) {
    for (const [entry, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(entry)
  }

  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return null
  }

  bucket.count += 1
  return bucket.count > limit ? throttled(bucket.resetAt, now) : null
}

export function clearRateLimit(key: string): void {
  buckets.delete(boundedKey(key))
}
