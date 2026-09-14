import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { presign } from '@/lib/r2'

export const runtime = 'nodejs'

const TYPES: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' }
const MAX_BYTES = 5 * 1024 * 1024

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get('key')
  if (!key || !/^fonts\/[a-f0-9]+\.(woff2|woff|ttf|otf)$/.test(key)) {
    return NextResponse.json({ ok: false, error: 'Bad key' }, { status: 400 })
  }
  const upstream = await fetch(presign(key, 'GET', 300)).catch(() => null)
  if (!upstream?.ok) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  return new NextResponse(upstream.body, {
    headers: {
      'content-type': TYPES[key.split('.').pop() ?? ''] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    },
  })
}

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (!account.email) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const extension = (new URL(req.url).searchParams.get('ext') ?? '').toLowerCase()
  if (!TYPES[extension]) return NextResponse.json({ ok: false, error: 'Use a WOFF2, WOFF, TTF or OTF font file.' }, { status: 400 })

  const bytes = Buffer.from(await req.arrayBuffer())
  if (bytes.length === 0) return NextResponse.json({ ok: false, error: 'That file is empty.' }, { status: 400 })
  if (bytes.length > MAX_BYTES) return NextResponse.json({ ok: false, error: 'Keep the font under 5MB.' }, { status: 413 })

  const key = `fonts/${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${extension}`
  const put = await fetch(presign(key, 'PUT', 300), { method: 'PUT', headers: { 'content-type': TYPES[extension] }, body: bytes }).catch(() => null)
  if (!put?.ok) return NextResponse.json({ ok: false, error: 'Could not store that font.' }, { status: 502 })
  return NextResponse.json({ ok: true, url: `/api/mail/fonts?key=${encodeURIComponent(key)}` })
}
