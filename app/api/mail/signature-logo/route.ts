import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { presign } from '@/lib/r2'

export const runtime = 'nodejs'

const MAX_BYTES = 2 * 1024 * 1024
const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

/**
 * A signature logo has to stay reachable for whoever opens the mail, months later, so it
 * cannot be a presigned link that expires or an attachment. The bytes live in the bucket
 * and this route streams them back under a stable, unauthenticated URL — the same one
 * embedded in every message that carries the signature.
 */
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get('key')
  if (!key || !/^signatures\/[A-Za-z0-9._-]+$/.test(key)) {
    return NextResponse.json({ ok: false, error: 'Bad key' }, { status: 400 })
  }
  const upstream = await fetch(presign(key, 'GET', 300)).catch(() => null)
  if (!upstream?.ok) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  return new NextResponse(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (!account.email) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const contentType = (req.headers.get('content-type') ?? '').split(';')[0].trim()
  const extension = TYPES[contentType]
  if (!extension) {
    return NextResponse.json({ ok: false, error: 'Use a PNG, JPEG, GIF, WebP or SVG image.' }, { status: 400 })
  }

  const bytes = Buffer.from(await req.arrayBuffer())
  if (bytes.length === 0) return NextResponse.json({ ok: false, error: 'That file is empty.' }, { status: 400 })
  if (bytes.length > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: 'Keep the logo under 2MB.' }, { status: 413 })
  }

  // Content-addressed, so re-uploading the same logo does not pile up copies.
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
  const key = `signatures/${digest}.${extension}`
  const put = await fetch(presign(key, 'PUT', 300), {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: bytes,
  }).catch(() => null)
  if (!put?.ok) return NextResponse.json({ ok: false, error: 'Could not store that image.' }, { status: 502 })

  return NextResponse.json({ ok: true, url: `/api/mail/signature-logo?key=${encodeURIComponent(key)}` })
}
