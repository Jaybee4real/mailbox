import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { backfillAttachments } from '@/lib/mailbox'

export const runtime = 'nodejs'
export const maxDuration = 300

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
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100)
  const result = await backfillAttachments(limit, url.searchParams.get('count') === '1')
  return NextResponse.json({ ok: true, ...result })
}
