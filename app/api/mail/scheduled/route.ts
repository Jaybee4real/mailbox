import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { scopeFor } from '@/lib/scope'
import { listScheduled, cancelScheduled } from '@/lib/scheduled'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  const scope = scopeFor(account, new URL(req.url).searchParams.get('mailbox'))
  return NextResponse.json({ ok: true, scheduled: await listScheduled(scope) })
}

export async function DELETE(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 })
  const cancelled = await cancelScheduled(id, account.address ?? '')
  if (!cancelled) {
    return NextResponse.json({ ok: false, error: 'That message is not waiting to be sent' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
