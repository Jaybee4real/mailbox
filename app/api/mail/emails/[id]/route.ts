import { NextResponse } from 'next/server'
import { Resend } from 'resend'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { mayReadSent } from '@/lib/sent-access'
import { getSentAttachments, readSentMessage } from '@/lib/mailbox'

export const runtime = 'nodejs'

function getResend(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY
  return apiKey ? new Resend(apiKey) : null
}

/**
 * Imported archives were never in Resend, and a provider drops its copy eventually anyway;
 * our own mail_sent row is the durable source, and the provider is asked only for the
 * details it alone holds (attachment links, schedule, delivery state).
 */
/** Served through this domain rather than the provider's host, which does not resolve on some of the networks the office uses. */
function attachmentList(id: string, entries: Array<Record<string, unknown>>) {
  return entries.map((entry, index) => ({
    filename: String(entry.filename ?? 'attachment'),
    size: Number(entry.size ?? 0),
    downloadUrl: `/api/mail/emails/${encodeURIComponent(id)}/attachments/download?index=${index}`,
  }))
}

async function fromArchive(id: string) {
  const stored = await readSentMessage(id).catch(() => null)
  if (!stored) return null
  const files = await getSentAttachments(id).catch(() => [])
  return NextResponse.json({
    ok: true,
    email: {
      id: stored.id,
      from: stored.from,
      to: stored.to,
      cc: stored.cc,
      bcc: stored.bcc,
      replyTo: stored.replyTo[0] ?? null,
      subject: stored.subject || '(no subject)',
      html: stored.html,
      text: stored.text,
      createdAt: stored.createdAt,
      scheduledAt: null,
      lastEvent: stored.lastEvent ?? '',
      attachments: attachmentList(id, files as Array<Record<string, unknown>>),
    },
  })
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const { id } = await params
  if (!(await mayReadSent(await resolveAccount(req), id))) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  const resend = getResend()

  if (id.startsWith('mbox-') || !resend) {
    const archived = await fromArchive(id)
    if (archived) return archived
    return NextResponse.json({ ok: false, error: resend ? 'Not found' : 'RESEND_API_KEY not configured' }, { status: resend ? 404 : 500 })
  }

  const { data, error } = await resend.emails.get(id)
  if (error) {
    const archived = await fromArchive(id)
    if (archived) return archived
    return NextResponse.json({ ok: false, error: error.message }, { status: 502 })
  }

  const stored = await getSentAttachments(id).catch(() => [])
  const rawAttachments = stored.some(entry => entry.key)
    ? stored
    : ((await resend.emails.attachments.list({ emailId: id }).catch(() => null))?.data as unknown as {
        data?: Array<Record<string, unknown>>
      })?.data ?? []
  const attachments = attachmentList(id, rawAttachments as Array<Record<string, unknown>>)

  const item = data as unknown as Record<string, unknown>
  return NextResponse.json({
    ok: true,
    email: {
      id: String(item.id ?? id),
      from: String(item.from ?? ''),
      to: Array.isArray(item.to) ? (item.to as string[]) : [String(item.to ?? '')],
      cc: Array.isArray(item.cc) ? (item.cc as string[]) : [],
      bcc: Array.isArray(item.bcc) ? (item.bcc as string[]) : [],
      replyTo: item.reply_to ? String(item.reply_to) : null,
      subject: String(item.subject ?? '(no subject)'),
      html: item.html ? String(item.html) : null,
      text: item.text ? String(item.text) : null,
      createdAt: String(item.created_at ?? ''),
      scheduledAt: item.scheduled_at ? String(item.scheduled_at) : null,
      lastEvent: String(item.last_event ?? ''),
      attachments,
    },
  })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const resend = getResend()
  if (!resend) return NextResponse.json({ ok: false, error: 'RESEND_API_KEY not configured' }, { status: 500 })

  const { id } = await params
  if (!(await mayReadSent(await resolveAccount(req), id))) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  let body: { scheduledAt?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.scheduledAt) {
    return NextResponse.json({ ok: false, error: 'scheduledAt is required' }, { status: 400 })
  }

  const { error } = await resend.emails.update({ id, scheduledAt: body.scheduledAt })
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 502 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const resend = getResend()
  if (!resend) return NextResponse.json({ ok: false, error: 'RESEND_API_KEY not configured' }, { status: 500 })

  const { id } = await params
  if (!(await mayReadSent(await resolveAccount(req), id))) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  const { error } = await resend.emails.cancel(id)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 502 })
  return NextResponse.json({ ok: true })
}
