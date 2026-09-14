import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { presign } from '@/lib/r2'

export const runtime = 'nodejs'

const MAX_BYTES = 2 * 1024 * 1024 * 1024

/**
 * Hands back a presigned PUT so the browser uploads straight to the bucket. The bytes
 * never pass through a serverless function, which has a request-body ceiling far below
 * what people attach, and the URL is short-lived so it is not a standing grant.
 */
export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (!account.email) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: { filename?: string; size?: number; contentType?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const filename = (body.filename ?? '').trim()
  if (!filename) return NextResponse.json({ ok: false, error: 'A filename is required.' }, { status: 400 })
  if ((body.size ?? 0) > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: 'That file is larger than 2GB.' }, { status: 413 })
  }

  const safe = filename.replace(/[^\w.\- ]+/g, '_').slice(0, 120)
  const key = `outgoing/${randomBytes(9).toString('hex')}/${safe}`
  return NextResponse.json({ ok: true, key, uploadUrl: presign(key, 'PUT', 3600) })
}
