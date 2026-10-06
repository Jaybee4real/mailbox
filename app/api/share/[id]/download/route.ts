import { NextResponse } from 'next/server'
import { signedInAs } from '@/lib/dev-auth'
import { getShare } from '@/lib/mailbox'
import { getObject, objectExists } from '@/lib/r2'
import { viewableType } from '@/lib/share-policy'
import { shareTicketMode } from '@/lib/share-ticket'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const GONE = { ok: false as const, error: 'This link is no longer available.' }

/**
 * The bytes of a shared file, served from this domain.
 *
 * The share page used to send the browser to a signed bucket URL. That is a second
 * hostname for the recipient's network to resolve and reach, and on the networks this
 * office deals with it sometimes cannot be — which looked exactly like a dead button,
 * because a failed navigation reports nothing back to the page it left. Every other
 * attachment in this product is already served from here; this one now is too.
 */
async function resolve(req: Request, id: string, ticket: string | null) {
  const mode = shareTicketMode(ticket, id)
  if (!mode) return { error: NextResponse.json(GONE, { status: 403 }) }
  const share = await getShare(id)
  if (!share || share.revoked) return { error: NextResponse.json(GONE, { status: 404 }) }
  const now = Date.now()
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= now) {
    return { error: NextResponse.json(GONE, { status: 410 }) }
  }
  if (share.availableAt && new Date(share.availableAt).getTime() > now && !(await signedInAs(req, share.owner))) {
    return { error: NextResponse.json(GONE, { status: 403 }) }
  }
  const inlineType = mode === 'view' ? viewableType(share.filename) : null
  if (mode === 'view' && !inlineType) return { error: NextResponse.json(GONE, { status: 403 }) }
  return { share, mode, inlineType }
}

function disposition(filename: string, inline: boolean): string {
  const plain = filename.replace(/["\\]/g, '')
  return `${inline ? 'inline' : 'attachment'}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Lets the page check the file is reachable before it sends the reader away from it. */
export async function HEAD(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const { share, inlineType, error } = await resolve(req, id, new URL(req.url).searchParams.get('t'))
  if (error) return error
  if (!(await objectExists(share.objectKey))) return NextResponse.json(GONE, { status: 410 })
  return new Response(null, {
    headers: {
      'content-type': inlineType ?? (share.contentType || 'application/octet-stream'),
      'content-length': String(share.size),
      'content-disposition': disposition(share.filename, Boolean(inlineType)),
      'accept-ranges': 'bytes',
    },
  })
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const { share, inlineType, error } = await resolve(req, id, new URL(req.url).searchParams.get('t'))
  if (error) return error

  const range = req.headers.get('range')
  const object = await getObject(share.objectKey, range && /^bytes=\d*-\d*$/.test(range) ? range : null)
  if (!object?.body) {
    return NextResponse.json(
      { ok: false, error: 'This file is no longer stored. Ask whoever sent it to upload it again.' },
      { status: 410 },
    )
  }
  const length = object.headers.get('content-length')
  const contentRange = object.status === 206 ? object.headers.get('content-range') : null
  return new Response(object.body, {
    status: contentRange ? 206 : 200,
    headers: {
      'content-type': inlineType ?? (share.contentType || object.headers.get('content-type') || 'application/octet-stream'),
      'content-disposition': disposition(share.filename, Boolean(inlineType)),
      ...(length ? { 'content-length': length } : {}),
      ...(contentRange ? { 'content-range': contentRange } : {}),
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
