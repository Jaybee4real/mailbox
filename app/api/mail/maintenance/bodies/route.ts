import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { migrateBodiesToBucket } from '@/lib/mailbox'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * Maintenance is driven by a script rather than a browser, so it carries its own token —
 * separate from the session secret, which cannot be rotated without signing everybody out.
 */
function authorised(req: Request): boolean {
  const secret = process.env.MAINTENANCE_TOKEN
  if (!secret) return false
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (token.length !== secret.length) return false
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(secret))
  } catch {
    return false
  }
}

export async function POST(req: Request) {
  if (!authorised(req)) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 403 })
  const url = new URL(req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 40) || 40, 200)
  const result = await migrateBodiesToBucket(limit, url.searchParams.get('count') === '1')
  return NextResponse.json({ ok: true, ...result })
}
