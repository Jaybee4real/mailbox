import { NextResponse } from 'next/server'

type Bucket = { count: number; resetAt: number }

// ponytail: per-instance memory, so a serverless fan-out multiplies the real ceiling by the
// number of warm lambdas. Enough to stop a single-host credential stuffer; move to Turso or
// Upstash if the limit ever needs to be exact.
const buckets = new Map<string, Bucket>()

export function clientKey(req: Request, scope: string): string {
  const forwarded = req.headers.get('x-forwarded-for') ?? ''
  const address = forwarded.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown'
  return `${scope}:${address}`
}

/** Returns a 429 when the caller is over budget, otherwise null. */
export function rateLimit(key: string, limit: number, windowMs: number): NextResponse | null {
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
  if (bucket.count > limit) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
    return NextResponse.json(
      { ok: false, error: 'Too many attempts. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    )
  }
  return null
}

export function clearRateLimit(key: string): void {
  buckets.delete(key)
}
