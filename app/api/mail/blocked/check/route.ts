import { NextResponse } from 'next/server'
import { mailAuthGuard } from '@/lib/dev-auth'
import { blockedAmong } from '@/lib/blocked'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The composer asks about addresses as they are typed, so a blocked one shows before Send. */
export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const body = (await req.json().catch(() => null)) as { addresses?: unknown } | null
  const addresses = Array.isArray(body?.addresses) ? body.addresses.filter((entry): entry is string => typeof entry === 'string').slice(0, 100) : []
  return NextResponse.json({ ok: true, blocked: await blockedAmong(addresses) })
}
