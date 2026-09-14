import { NextResponse } from 'next/server'
import { mailAuthGuard } from '@/lib/dev-auth'
import { getInboundAttachments } from '@/lib/mailbox'
import { getObject } from '@/lib/r2'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Serves attachment bytes from this domain rather than handing the browser a bucket or
 * provider URL. Those hosts are a separate name to resolve and reach, and on the networks
 * the office actually uses some of them do not resolve at all — the message opens, the
 * attachment does not. The reader already reached this origin to load the page, so
 * anything served from here is reachable by definition.
 */
export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  const params = new URL(req.url).searchParams
  const id = params.get('id')
  const index = Number(params.get('index') ?? 0)
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 })

  // The key is read from the message rather than taken from the caller, so this cannot
  // be pointed at an arbitrary object in the bucket.
  const attachments = await getInboundAttachments(id).catch(() => [])
  const entry = attachments[Number.isFinite(index) ? index : 0]
  const key = entry && typeof entry.key === 'string' ? entry.key : ''
  if (!key) return NextResponse.json({ ok: false, error: 'That file is not stored here.' }, { status: 404 })

  const object = await getObject(key)
  if (!object || !object.body) {
    return NextResponse.json({ ok: false, error: 'That file could not be read.' }, { status: 502 })
  }

  const filename = String(entry.filename ?? 'attachment').replace(/["\\]/g, '')
  // The preview and the download button share this route. `attachment` tells the browser
  // to save rather than render, which turns a preview into a download — so the viewer
  // asks for `inline` and only the download button gets the other.
  const inline = params.get('inline') === '1'
  return new Response(object.body, {
    headers: {
      'content-type': String(entry.contentType ?? object.headers.get('content-type') ?? 'application/octet-stream'),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
      ...(object.headers.get('content-length') ? { 'content-length': object.headers.get('content-length')! } : {}),
      'cache-control': 'private, max-age=3600',
    },
  })
}
