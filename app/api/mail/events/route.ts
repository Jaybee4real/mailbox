import { NextResponse } from 'next/server'
import { mailAuthGuard } from '@/lib/dev-auth'
import { readEvents } from '@/lib/mailbox'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const events = await readEvents()
  return NextResponse.json({ ok: true, events })
}
