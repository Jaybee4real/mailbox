import { NextResponse } from 'next/server'
import { getShare, getSharePasswordHash, recordShareDownload } from '@/lib/mailbox'
import { verifyPassword } from '@/lib/password'
import { objectExists } from '@/lib/r2'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { issueShareTicket } from '@/lib/share-ticket'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Deliberately public: the recipient is not a mailbox holder. The share id is the
 * capability, and the password (when set) is the second factor. Every refusal
 * reads the same so the endpoint cannot be used to sort real ids from invented
 * ones by their error message.
 */
const GONE = { ok: false as const, error: 'This link is no longer available.' }

/** What the page needs to render before anyone types anything. */
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const share = await getShare(id)
  if (!share || share.revoked) return NextResponse.json(GONE, { status: 404 })
  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return NextResponse.json(GONE, { status: 410 })
  }
  if (share.maxDownloads != null && share.downloads >= share.maxDownloads) {
    return NextResponse.json(GONE, { status: 410 })
  }
  return NextResponse.json({
    ok: true,
    filename: share.filename,
    size: share.size,
    contentType: share.contentType,
    needsPassword: share.hasPassword,
    expiresAt: share.expiresAt,
    downloadsLeft: share.maxDownloads == null ? null : share.maxDownloads - share.downloads,
  })
}

/** Exchanges the password for a short-lived link to the bytes, served from this domain. */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params

  // The password is guessable one attempt at a time, so cap the attempts.
  const limited = rateLimit(`${clientKey(req, 'share')}:${id}`, 10, 15 * 60 * 1000)
  if (limited) return limited

  const share = await getShare(id)
  if (!share || share.revoked) return NextResponse.json(GONE, { status: 404 })
  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return NextResponse.json(GONE, { status: 410 })
  }
  if (share.maxDownloads != null && share.downloads >= share.maxDownloads) {
    return NextResponse.json(GONE, { status: 410 })
  }

  if (share.hasPassword) {
    let password = ''
    try {
      password = String(((await req.json()) as { password?: string }).password ?? '')
    } catch {
      // Leave it empty and fall through to the same refusal.
    }
    const hash = await getSharePasswordHash(id)
    if (!hash || !(await verifyPassword(password, hash))) {
      return NextResponse.json({ ok: false, error: 'That password is not right.' }, { status: 403 })
    }
  }

  // Checked before the download is counted, so a missing object does not burn one of
  // the recipient's allowed downloads.
  if (!(await objectExists(share.objectKey))) {
    return NextResponse.json(
      { ok: false, error: 'This file is no longer stored. Ask whoever sent it to upload it again.' },
      { status: 410 },
    )
  }

  await recordShareDownload(id)
  // Served from this domain rather than the bucket: the bucket is a second hostname for
  // the recipient's network to reach, and when it cannot the download silently never
  // starts. The ticket carries the password decision the short distance to the bytes.
  const ticket = issueShareTicket(id)
  if (!ticket) {
    return NextResponse.json({ ok: false, error: 'Downloads are not configured.' }, { status: 503 })
  }
  const url = `/api/share/${encodeURIComponent(id)}/download?t=${encodeURIComponent(ticket)}`
  return NextResponse.json({ ok: true, url, filename: share.filename })
}
