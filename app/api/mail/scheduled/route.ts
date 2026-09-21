import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { scopeFor } from '@/lib/scope'
import { listScheduled, cancelScheduled, rescheduleSend } from '@/lib/scheduled'

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

export async function PATCH(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  const body = (await req.json().catch(() => null)) as { id?: string; scheduledAt?: string } | null
  const id = body?.id ?? new URL(req.url).searchParams.get('id') ?? ''
  const when = body?.scheduledAt ? new Date(body.scheduledAt) : null
  if (!id || !when || Number.isNaN(when.getTime())) {
    return NextResponse.json({ ok: false, error: 'id and a valid scheduledAt are required' }, { status: 400 })
  }
  if (when.getTime() <= Date.now()) {
    return NextResponse.json({ ok: false, error: 'Pick a time in the future' }, { status: 400 })
  }
  const moved = await rescheduleSend(id, account.address ?? '', when.toISOString())
  if (!moved) {
    return NextResponse.json({ ok: false, error: 'That message is not waiting to be sent' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, scheduledAt: when.toISOString() })
}
