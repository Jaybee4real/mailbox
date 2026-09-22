import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { publicOrigin } from '@/lib/public-url'
import { presign } from '@/lib/r2'

export const runtime = 'nodejs'

const MAX_BYTES = 8 * 1024 * 1024
const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

/** The type the bytes say they are; a browser's label for a file is often missing or wrong. */
function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1')
    if (/^(heic|heix|hevc|mif1|msf1)/.test(brand)) return 'image/heic'
    if (/^avi[fs]/.test(brand)) return 'image/avif'
  }
  const head = bytes.subarray(0, 512).toString('utf8').trimStart().toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml'
  return null
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

  const bytes = Buffer.from(await req.arrayBuffer())
  if (bytes.length === 0) return NextResponse.json({ ok: false, error: 'That file is empty.' }, { status: 400 })
  if (bytes.length > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: 'Keep the image under 8MB.' }, { status: 413 })
  }

  const declared = (req.headers.get('content-type') ?? '').split(/[;,]/)[0].trim().toLowerCase()
  const sniffed = sniffImageType(bytes)
  // Raster formats always announce themselves in their first bytes; only SVG is taken on the label.
  const contentType = sniffed && TYPES[sniffed] ? sniffed : !sniffed && declared === 'image/svg+xml' ? declared : ''
  const extension = TYPES[contentType]
  if (!extension) {
    if (sniffed === 'image/heic' || sniffed === 'image/avif') {
      return NextResponse.json(
        { ok: false, error: 'That is a HEIC/AVIF photo, which mail apps cannot display. Export it as JPEG or PNG first.' },
        { status: 400 },
      )
    }
    return NextResponse.json({ ok: false, error: 'Use a PNG, JPEG, GIF, WebP or SVG image.' }, { status: 400 })
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

  return NextResponse.json({ ok: true, url: `${publicOrigin(req)}/api/mail/signature-logo?key=${encodeURIComponent(key)}` })
}
