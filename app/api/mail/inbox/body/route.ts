import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { resolveInboundBody } from '@/lib/mailbox'
import { mayReadInbound } from '@/lib/sent-access'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 })
  if (!(await mayReadInbound(await resolveAccount(req), id))) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  const body = await resolveInboundBody(id).catch(() => ({ html: null, text: null }))
  return NextResponse.json({ ok: true, ...body })
}
