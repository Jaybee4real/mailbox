import { NextResponse } from 'next/server'
import { dispatchDue } from '@/lib/scheduled'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Sends everything now due. Driven by a timer rather than by someone having the mailbox
 * open, because a message written on Friday for Monday has nobody watching when its turn
 * comes. Safe to call as often as you like: each row is claimed before it is sent.
 */
export async function POST(req: Request) {
  const expected = (process.env.MAINTENANCE_TOKEN ?? '').trim()
  const offered = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!expected || offered !== expected) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ ok: true, ...(await dispatchDue()) })
}
