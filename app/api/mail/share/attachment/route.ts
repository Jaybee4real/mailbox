import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { createShare, getInboundSource } from '@/lib/mailbox'
import { hashPassword } from '@/lib/password'
import { presign } from '@/lib/r2'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Only our own stored copies are ever copied out. The client names a message and a
 * filename; the URL comes from the row, never from the request.
 */
const OWN_BLOB_HOST = /\.public\.blob\.vercel-storage\.com$/

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (!account.email) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: { messageId?: string; filename?: string; password?: string; expiresInDays?: number; maxDownloads?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  }

  const messageId = String(body.messageId ?? '')
  const filename = String(body.filename ?? '')
  if (!messageId || !filename) return NextResponse.json({ ok: false, error: 'Which attachment?' }, { status: 400 })

  const source = await getInboundSource(messageId)
  if (!source) return NextResponse.json({ ok: false, error: 'That message is not here.' }, { status: 404 })
  const address = (account.address ?? '').toLowerCase()
  const mine = Boolean(source.owner && address && source.owner.toLowerCase() === address)
  // Sharing publishes a file to anyone with the link, so it is limited to the mailbox
  // that received it — administering accounts does not extend to another person's files.
  if (!mine) {
    return NextResponse.json({ ok: false, error: 'That message is not yours to share.' }, { status: 403 })
  }

  const entry = source.attachments.find(item => String(item.filename ?? '') === filename && typeof item.url === 'string')
  let origin: URL | null = null
  try {
    origin = entry ? new URL(String(entry.url)) : null
  } catch {
    origin = null
  }
  if (!entry || !origin || !OWN_BLOB_HOST.test(origin.hostname)) {
    return NextResponse.json({ ok: false, error: 'That attachment has no stored copy to share.' }, { status: 404 })
  }

  const upstream = await fetch(origin.toString())
  if (!upstream.ok) return NextResponse.json({ ok: false, error: 'The stored copy could not be read.' }, { status: 502 })
  const bytes = Buffer.from(await upstream.arrayBuffer())
  const contentType = String(entry.contentType ?? upstream.headers.get('content-type') ?? 'application/octet-stream')

  const id = randomBytes(9).toString('base64url')
  const safe = filename.replace(/[^\w.\- ]+/g, '_').slice(-120)
  const objectKey = `shares/${randomBytes(16).toString('hex')}/${safe}`

  const put = await fetch(presign(objectKey, 'PUT', 300), {
    method: 'PUT',
    body: bytes,
    headers: { 'content-type': contentType },
  })
  if (!put.ok) {
    return NextResponse.json({ ok: false, error: 'Could not copy the file into share storage.' }, { status: 502 })
  }

  const expiresAt =
    body.expiresInDays && body.expiresInDays > 0
      ? new Date(Date.now() + body.expiresInDays * 86400_000).toISOString()
      : null
  await createShare({
    id,
    objectKey,
    filename,
    contentType,
    size: bytes.length,
    passwordHash: body.password ? await hashPassword(body.password) : null,
    owner: account.email,
    expiresAt,
    maxDownloads: body.maxDownloads && body.maxDownloads > 0 ? body.maxDownloads : null,
  })

  const base = process.env.MAIL_PUBLIC_URL?.replace(/\/$/, '') || new URL(req.url).origin
  return NextResponse.json({ ok: true, id, url: `${base}/share/${id}`, expiresAt })
}
