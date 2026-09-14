import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { assignThreads, refreshThreadsFrom } from '@/lib/mailbox'

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
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 300) || 300, 1000)
  if (url.searchParams.get('phase') === 'refresh') {
    const owner = url.searchParams.get('afterOwner')
    const threadId = url.searchParams.get('afterThread')
    const result = await refreshThreadsFrom(owner && threadId ? { owner, threadId } : null, limit)
    return NextResponse.json({ ok: true, ...result })
  }
  const result = await assignThreads(limit)
  return NextResponse.json({ ok: true, ...result })
}
