import { NextResponse } from 'next/server'
import { getShare } from '@/lib/mailbox'
import { getObject, objectExists } from '@/lib/r2'
import { shareTicketValid } from '@/lib/share-ticket'

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
async function resolve(id: string, ticket: string | null) {
  if (!shareTicketValid(ticket, id)) return { error: NextResponse.json(GONE, { status: 403 }) }
  const share = await getShare(id)
  if (!share || share.revoked) return { error: NextResponse.json(GONE, { status: 404 }) }
  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return { error: NextResponse.json(GONE, { status: 410 }) }
  }
  return { share }
}

function disposition(filename: string): string {
  const plain = filename.replace(/["\\]/g, '')
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Lets the page check the file is reachable before it sends the reader away from it. */
export async function HEAD(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const { share, error } = await resolve(id, new URL(req.url).searchParams.get('t'))
  if (error) return error
  if (!(await objectExists(share.objectKey))) return NextResponse.json(GONE, { status: 410 })
  return new Response(null, {
    headers: {
      'content-type': share.contentType || 'application/octet-stream',
      'content-length': String(share.size),
      'content-disposition': disposition(share.filename),
    },
  })
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const { share, error } = await resolve(id, new URL(req.url).searchParams.get('t'))
  if (error) return error

  const object = await getObject(share.objectKey)
  if (!object?.body) {
    return NextResponse.json(
      { ok: false, error: 'This file is no longer stored. Ask whoever sent it to upload it again.' },
      { status: 410 },
    )
  }
  const length = object.headers.get('content-length')
  return new Response(object.body, {
    headers: {
      'content-type': share.contentType || object.headers.get('content-type') || 'application/octet-stream',
      'content-disposition': disposition(share.filename),
      ...(length ? { 'content-length': length } : {}),
      'cache-control': 'private, no-store',
    },
  })
}
