import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { listInboundWithAttachments } from '@/lib/mailbox'
import { attachedFiles } from '@/lib/attachments'
import { scopeFor } from '@/lib/scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (!account.email) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  // The mailbox in view, as the inbox has it: the account that opens every inbox follows its
  // mailbox picker (null is all of them); anyone else sees their own.
  const owner = scopeFor(account, new URL(req.url).searchParams.get('mailbox'))
  const rows = await listInboundWithAttachments(owner)
  // Bytes have lived under `key` since they moved to our own bucket; only the oldest rows
  // still carry a provider `url`. Filtering on url alone hid nearly everything here, and
  // handed out a link this app cannot serve inline.
  const files = rows.flatMap(row => {
    const shown = new Set(attachedFiles(row.attachments, row.html))
    return row.attachments
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => shown.has(file))
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
      }))
  })
  return NextResponse.json({ ok: true, files })
}
