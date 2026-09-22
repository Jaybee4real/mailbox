import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { rejudgeStored } from '@/lib/mailbox'

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

/**
 * Re-reads stored mail through the current judgement and writes back what changed, a page
 * at a time — `cursor` in the answer is the `before` for the next call.
 */
export async function POST(req: Request) {
  if (!authorised(req)) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 403 })
  const url = new URL(req.url)
  const result = await rejudgeStored({
    before: url.searchParams.get('before') ?? undefined,
    limit: Number(url.searchParams.get('limit') ?? 200) || 200,
  })
  return NextResponse.json({ ok: true, ...result })
}
