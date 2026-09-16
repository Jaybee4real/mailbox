import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { mayReadSent } from '@/lib/sent-access'
import { getSentAttachments } from '@/lib/mailbox'
import { getObject } from '@/lib/r2'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Streams an attachment off a message we sent, through this domain.
 *
 * The provider hands out links on a host of its own, and on the networks the office
 * uses that host does not resolve — the message opens and the file does not. The
 * reader already reached this origin to load the page.
 */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  const { id } = await context.params
  if (!(await mayReadSent(await resolveAccount(req), id))) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  const params = new URL(req.url).searchParams
  const index = Number(params.get('index') ?? 0)
  const inline = params.get('inline') === '1'
  const position = Number.isFinite(index) ? index : 0

  const stored = (await getSentAttachments(id).catch(() => []))[position]
  if (stored?.key) {
    const object = await getObject(stored.key)
    if (object?.body) {
      const name = (stored.filename || 'attachment').replace(/["\\]/g, '')
      return new Response(object.body, {
        headers: {
          'content-type': stored.contentType ?? object.headers.get('content-type') ?? 'application/octet-stream',
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
          ...(object.headers.get('content-length') ? { 'content-length': object.headers.get('content-length')! } : {}),
          'cache-control': 'private, max-age=3600',
        },
      })
    }
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, error: 'Sending is not configured.' }, { status: 503 })

  const listing = await fetch(`https://api.resend.com/emails/${encodeURIComponent(id)}/attachments`, {
    headers: { authorization: `Bearer ${apiKey}` },
  }).catch(() => null)
  if (!listing?.ok) return NextResponse.json({ ok: false, error: 'That file could not be read.' }, { status: 502 })

  const payload = (await listing.json()) as { data?: Array<Record<string, unknown>> }
  const entry = (payload.data ?? [])[position]
  const source = entry?.download_url ? String(entry.download_url) : ''
  if (!source) return NextResponse.json({ ok: false, error: 'That file is no longer available.' }, { status: 404 })

  const file = await fetch(source).catch(() => null)
  if (!file?.ok || !file.body) {
    return NextResponse.json({ ok: false, error: 'That file could not be read.' }, { status: 502 })
  }

  const filename = String(entry.filename ?? 'attachment').replace(/["\\]/g, '')
  return new Response(file.body, {
    headers: {
      'content-type': String(entry.content_type ?? file.headers.get('content-type') ?? 'application/octet-stream'),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
      ...(file.headers.get('content-length') ? { 'content-length': file.headers.get('content-length')! } : {}),
      'cache-control': 'private, max-age=3600',
    },
  })
}
