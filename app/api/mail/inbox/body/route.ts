import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { getInboundAttachments, resolveInboundBody } from '@/lib/mailbox'
import { mayReadInbound } from '@/lib/sent-access'
import { inlineImageTicket } from '@/lib/share-ticket'
import { inlineImageUrls, referencedCids } from '@/lib/attachments'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 })
  if (!(await mayReadInbound(await resolveAccount(req), id))) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  const body = await resolveInboundBody(id).catch(() => ({ html: null, text: null }))
  const ticket = referencedCids(body.html).size ? inlineImageTicket(id) : null
  const inlineImages = ticket ? inlineImageUrls(id, await getInboundAttachments(id).catch(() => []), ticket) : {}
  return NextResponse.json({ ok: true, ...body, inlineImages })
}
