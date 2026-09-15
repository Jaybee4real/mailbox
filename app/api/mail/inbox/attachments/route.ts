import { NextResponse } from 'next/server'
import { mailAuthGuard } from '@/lib/dev-auth'
import { getInboundAttachments, resolveInboundBody, setInboundAttachments } from '@/lib/mailbox'
import { isEmbedded, referencedCids } from '@/lib/attachments'

export const runtime = 'nodejs'

/**
 * Our own rehosted copy wins over Resend's: the provider's download URLs expire and vanish
 * with the account, and imported archives were never in Resend to begin with.
 */
export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 })

  // Anything we hold is served back through this domain. A bucket link and a provider
  // link are both hosts the reader's network has to reach separately, and on some of
  // those networks they cannot be reached at all.
  const held = await getInboundAttachments(id).catch(() => [])
  // The body decides which images are decoration. Read once, not once per file.
  const body = await resolveInboundBody(id).catch(() => ({ html: null, text: null }))
  const referenced = referencedCids(body.html)
  const stored = held
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => typeof entry.key === 'string' && entry.key)
    .filter(({ entry }) => !isEmbedded(entry, referenced))
    .map(({ entry, index }) => ({
      filename: String(entry.filename ?? 'attachment'),
      size: Number(entry.size ?? 0),
      contentType: typeof entry.contentType === 'string' ? entry.contentType : undefined,
      downloadUrl: `/api/mail/inbox/attachments/download?id=${encodeURIComponent(id)}&index=${index}`,
    }))
  // A file too big to send was put behind a share page instead. We hold no bytes for it,
  // but it is not lost: it has somewhere to go, and a tile with nowhere to go is a dead end.
  const shared = held
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => typeof entry.shareId === 'string' && entry.shareId && !entry.key)
    .map(({ entry }) => ({
      filename: String(entry.filename ?? 'attachment'),
      size: Number(entry.size ?? 0),
      contentType: typeof entry.contentType === 'string' ? entry.contentType : undefined,
      shareId: String(entry.shareId),
      downloadUrl: `/share/${encodeURIComponent(String(entry.shareId))}`,
    }))
  if (stored.length || shared.length) return NextResponse.json({ ok: true, attachments: [...stored, ...shared] })

  // Nothing of ours yet: this message predates the copy-on-arrival. Pull the bytes from
  // the provider now and keep them, so the next reader is served from here and the file
  // survives the provider's own retention window.
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return NextResponse.json({ ok: true, attachments: [] })

  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}/attachments`, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) return NextResponse.json({ ok: true, attachments: [] })

  const payload = (await response.json()) as { data?: Array<Record<string, unknown>> }
  const listed = payload.data ?? []
  const { putObject } = await import('@/lib/r2')

  const kept = await Promise.all(
    listed.map(async (entry, index) => {
      const filename = String(entry.filename ?? 'attachment')
      const contentType = entry.content_type ? String(entry.content_type) : undefined
      const source = entry.download_url ? String(entry.download_url) : ''
      const contentId = entry.content_id ? String(entry.content_id).replace(/^<|>$/g, '') : undefined
      const meta: Record<string, unknown> = { filename, contentType, size: Number(entry.size ?? 0), contentId }
      if (!source) return meta
      try {
        const binary = await fetch(source)
        if (!binary.ok) return meta
        const bytes = Buffer.from(await binary.arrayBuffer())
        const safeName = filename.replace(/[^\w.\- ]+/g, '_').slice(-120)
        const key = `attachments/${id}/${index}-${safeName}`
        if (await putObject(key, bytes, contentType)) return { ...meta, size: bytes.length, key }
      } catch {
        // Fall through: the file is still listed, just not ours yet.
      }
      return meta
    }),
  )

  if (kept.some(entry => entry.key)) await setInboundAttachments(id, kept).catch(() => {})

  const attachments = kept.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !isEmbedded(entry, referenced))
    .map(({ entry, index }) => ({
    filename: String(entry.filename ?? 'attachment'),
    size: Number(entry.size ?? 0),
    // Only ours are offered. A provider link that the reader's network cannot reach is
    // worse than none: it looks like the app is broken rather than the file being absent.
    downloadUrl: entry.key ? `/api/mail/inbox/attachments/download?id=${encodeURIComponent(id)}&index=${index}` : '',
  }))
  return NextResponse.json({ ok: true, attachments })
}
