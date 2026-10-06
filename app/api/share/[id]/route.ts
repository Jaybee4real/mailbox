import { NextResponse } from 'next/server'
import { claimShare, getShare, getSharePasswordHash } from '@/lib/mailbox'
import { verifyPassword } from '@/lib/password'
import { objectExists } from '@/lib/r2'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { shareGate, viewKind } from '@/lib/share-policy'
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

const opensOn = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })

/** What the page needs to render before anyone types anything. */
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const share = await getShare(id)
  if (!share) return NextResponse.json(GONE, { status: 404 })
  const gate = shareGate(share)
  if (gate.state === 'gone') return NextResponse.json(GONE, { status: 410 })
  return NextResponse.json({
    ok: true,
    filename: share.filename,
    size: share.size,
    contentType: share.contentType,
    needsPassword: share.hasPassword,
    expiresAt: share.expiresAt,
    availableAt: share.availableAt,
    pending: gate.state === 'pending',
    canView: gate.canView,
    canDownload: gate.canDownload,
    viewKind: viewKind(share.filename),
    downloadsLeft: share.maxDownloads == null ? null : Math.max(0, share.maxDownloads - share.downloads),
    viewsLeft: share.maxViews == null ? null : Math.max(0, share.maxViews - share.views),
  })
}

/** Exchanges the password for a short-lived link to the bytes, served from this domain. */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params

  // The password is guessable one attempt at a time, so cap the attempts.
  const limited = rateLimit(`${clientKey(req, 'share')}:${id}`, 10, 15 * 60 * 1000)
  if (limited) return limited

  let body: { password?: unknown; mode?: unknown } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    body = {}
  }
  const mode = body.mode === 'view' ? 'view' : 'download'

  const share = await getShare(id)
  if (!share) return NextResponse.json(GONE, { status: 404 })
  const gate = shareGate(share)
  if (gate.state === 'gone') return NextResponse.json(GONE, { status: 410 })
  if (gate.state === 'pending' && share.availableAt) {
    return NextResponse.json({ ok: false, error: `This file opens on ${opensOn(share.availableAt)}.` }, { status: 403 })
  }
  if (mode === 'view' ? !gate.canView : !gate.canDownload) {
    const error = mode === 'view' ? 'This file can no longer be viewed here.' : 'This file can be viewed, but not downloaded.'
    return NextResponse.json({ ok: false, error }, { status: 403 })
  }

  if (share.hasPassword) {
    const hash = await getSharePasswordHash(id)
    if (!hash || !(await verifyPassword(String(body.password ?? ''), hash))) {
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

  if (!(await claimShare(id, mode))) return NextResponse.json(GONE, { status: 410 })
  // Served from this domain rather than the bucket: the bucket is a second hostname for
  // the recipient's network to reach, and when it cannot the download silently never
  // starts. The ticket carries the password decision the short distance to the bytes.
  const ticket = issueShareTicket(id, mode)
  if (!ticket) {
    return NextResponse.json({ ok: false, error: 'Downloads are not configured.' }, { status: 503 })
  }
  const url = `/api/share/${encodeURIComponent(id)}/download?t=${encodeURIComponent(ticket)}`
  return NextResponse.json({ ok: true, url, filename: share.filename, mode })
}
