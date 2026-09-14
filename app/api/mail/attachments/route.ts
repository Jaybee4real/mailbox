import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { listInboundWithAttachments } from '@/lib/mailbox'

// The attachment list is found with a LIKE over the mailbox, which no index can serve:
// every row the owner has is examined on each call, and Turso meters every one of
// them. A warm instance answers repeat callers from memory for five minutes.
const FILES_TTL_MS = 5 * 60 * 1000
type FileRows = Awaited<ReturnType<typeof listInboundWithAttachments>>
const filesCache = new Map<string, { at: number; value: FileRows }>()
async function cachedFiles(owner: string | null): Promise<FileRows> {
  const key = owner ?? ''
  const hit = filesCache.get(key)
  if (hit && Date.now() - hit.at < FILES_TTL_MS) return hit.value
  const value = await cachedFiles(owner)
  filesCache.set(key, { at: Date.now(), value })
  return value
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (!account.email) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  // Null would list every mailbox's files; the Files panel shows the signed-in one.
  const owner = account.address ?? account.email
  const rows = await listInboundWithAttachments(owner)
  // Bytes have lived under `key` since they moved to our own bucket; only the oldest rows
  // still carry a provider `url`. Filtering on url alone hid nearly everything here, and
  // handed out a link this app cannot serve inline.
  const files = rows.flatMap(row =>
    row.attachments
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => (typeof file.key === 'string' && file.key) || (typeof file.url === 'string' && file.url))
      .map(({ file, index }) => ({
        messageId: row.id,
        filename: String(file.filename ?? 'attachment'),
        size: Number(file.size ?? 0),
        contentType: file.contentType ? String(file.contentType) : undefined,
        url:
          typeof file.key === 'string' && file.key
            ? `/api/mail/inbox/attachments/download?id=${encodeURIComponent(row.id)}&index=${index}`
            : String(file.url),
        subject: row.subject,
        from: row.from,
        at: row.receivedAt,
      })),
  )
  return NextResponse.json({ ok: true, files })
}
