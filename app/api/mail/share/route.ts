import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { createShare, getShare, listShares, revokeShare, setSharePassword } from '@/lib/mailbox'
import { hashPassword } from '@/lib/password'
import { deleteObject, presign } from '@/lib/r2'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Large enough for video, small enough that a mistake is not a bill. */
const MAX_SHARE_BYTES = 2 * 1024 * 1024 * 1024

/** Keeps the stored key opaque, so the object name leaks nothing about the sender. */
function objectKeyFor(filename: string): string {
  const safe = filename.replace(/[^\w.\- ]+/g, '_').slice(-120)
  return `shares/${randomBytes(16).toString('hex')}/${safe}`
}

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (!account.email) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })
  return NextResponse.json({ ok: true, shares: await listShares(account.email) })
}

/**
 * Registers a file and hands back a URL the browser can PUT straight to. The bytes
 * never pass through this server, so there is no request-body ceiling and a two
 * gigabyte upload costs us nothing but the signature.
 */
export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (!account.email) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: {
    filename?: string
    contentType?: string
    size?: number
    password?: string
    expiresInDays?: number
    maxDownloads?: number
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  }

  const filename = String(body.filename ?? '').trim()
  const size = Number(body.size ?? 0)
  if (!filename) return NextResponse.json({ ok: false, error: 'A filename is required.' }, { status: 400 })
  if (!Number.isFinite(size) || size <= 0) {
    return NextResponse.json({ ok: false, error: 'A file size is required.' }, { status: 400 })
  }
  if (size > MAX_SHARE_BYTES) {
    return NextResponse.json({ ok: false, error: 'That file is larger than 2GB.' }, { status: 413 })
  }

  const id = randomBytes(9).toString('base64url')
  const objectKey = objectKeyFor(filename)
  const expiresAt =
    body.expiresInDays && body.expiresInDays > 0
      ? new Date(Date.now() + body.expiresInDays * 86400_000).toISOString()
      : null

  try {
    await createShare({
      id,
      objectKey,
      filename,
      contentType: body.contentType ?? null,
      size,
      passwordHash: body.password ? await hashPassword(body.password) : null,
      owner: account.email,
      expiresAt,
      maxDownloads: body.maxDownloads && body.maxDownloads > 0 ? body.maxDownloads : null,
    })
    // An hour is plenty for the upload itself and short enough that a leaked URL
    // is not a standing grant.
    const uploadUrl = presign(objectKey, 'PUT', 3600)
    return NextResponse.json({ ok: true, id, uploadUrl, objectKey })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Could not prepare the upload.' },
      { status: 500 },
    )
  }
}

/** Sets or clears the password on a share the caller owns. */
export async function PATCH(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (!account.email) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: { id?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  }

  const id = String(body.id ?? '')
  if (!id) return NextResponse.json({ ok: false, error: 'Which share?' }, { status: 400 })

  const password = String(body.password ?? '').trim()
  const updated = await setSharePassword(id, account.email, password ? await hashPassword(password) : null)
  return NextResponse.json({ ok: updated }, { status: updated ? 200 : 404 })
}

export async function DELETE(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (!account.email) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ ok: false, error: 'Which share?' }, { status: 400 })
  // Flag first so the link dies even if storage is unreachable; then drop the bytes,
  // because a revoked file that still sits in the bucket is not revoked.
  const share = await getShare(id)
  const revoked = await revokeShare(id, account.email)
  if (revoked && share?.objectKey) await deleteObject(share.objectKey).catch(() => false)
  return NextResponse.json({ ok: revoked }, { status: revoked ? 200 : 404 })
}
