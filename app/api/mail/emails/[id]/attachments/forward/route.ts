import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { mayReadSent } from '@/lib/sent-access'
import { getSentAttachments } from '@/lib/mailbox'
import { getObject, putObject } from '@/lib/r2'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Copies the files on a message we sent into a fresh outgoing key, so it can be
 * forwarded.
 *
 * Anything sent since we started recording keys is already in our bucket and is copied
 * from there. Older messages only exist at the provider, so those are pulled back and
 * stored on the way through — which also means the next forward of the same message no
 * longer depends on the provider still having it.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  const { id } = await context.params
  if (!(await mayReadSent(await resolveAccount(req), id))) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  const copied: Array<{ filename: string; size: number; contentType?: string; key: string }> = []

  const mint = (filename: string) =>
    `outgoing/${randomBytes(9).toString('hex')}/${filename.replace(/[^\w.\- ]+/g, '_').slice(0, 120)}`

  const ours = await getSentAttachments(id).catch(() => [])
  for (const entry of ours) {
    if (!entry.key) continue
    const object = await getObject(entry.key)
    if (!object) continue
    const bytes = Buffer.from(await object.arrayBuffer())
    const key = mint(entry.filename)
    if (!(await putObject(key, bytes, entry.contentType))) continue
    copied.push({ filename: entry.filename, size: bytes.length, contentType: entry.contentType, key })
  }
  if (copied.length) return NextResponse.json({ ok: true, attachments: copied })

  // Nothing of ours recorded: this predates that, so fall back to the provider.
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return NextResponse.json({ ok: true, attachments: [] })

  const listing = await fetch(`https://api.resend.com/emails/${encodeURIComponent(id)}/attachments`, {
    headers: { authorization: `Bearer ${apiKey}` },
  }).catch(() => null)
  if (!listing?.ok) return NextResponse.json({ ok: true, attachments: [] })

  const payload = (await listing.json()) as { data?: Array<Record<string, unknown>> }
  for (const entry of payload.data ?? []) {
    const source = entry.download_url ? String(entry.download_url) : ''
    if (!source) continue
    const file = await fetch(source).catch(() => null)
    if (!file?.ok) continue
    const bytes = Buffer.from(await file.arrayBuffer())
    const filename = String(entry.filename ?? 'attachment')
    const contentType = entry.content_type ? String(entry.content_type) : undefined
    const key = mint(filename)
    if (!(await putObject(key, bytes, contentType))) continue
    copied.push({ filename, size: bytes.length, contentType, key })
  }

  return NextResponse.json({ ok: true, attachments: copied })
}
