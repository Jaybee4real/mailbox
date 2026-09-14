import { BRAND } from '@/lib/brand'
import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { sendMail } from '@/lib/mail-provider'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { presign } from '@/lib/r2'
import { recordContact, recordPixel, recordSentMeta, recordSentMessage } from '@/lib/mailbox'
import { publicOrigin } from '@/lib/public-url'

export const runtime = 'nodejs'

type SendBody = {
  to?: string[]
  cc?: string[]
  bcc?: string[]
  replyTo?: string
  fromName?: string
  subject?: string
  html?: string
  text?: string
  scheduledAt?: string
  inReplyTo?: string
  /** Admin only: the mailbox to send on behalf of. */
  actAs?: string
  attachments?: Array<{ filename: string; content?: string; path?: string; key?: string }>
}

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  const account = await resolveAccount(req)

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: 'RESEND_API_KEY not configured' }, { status: 500 })
  }

  let body: SendBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const recipients = (body.to ?? []).filter(Boolean)

  // Send from the accessor's personal address so replies route back to their mailbox.
  //
  // Mail goes out as the account that is signed in. Sending as somebody else went with
  // browsing their mailbox, which no longer happens; the claim is refused here rather
  // than trusted, because the client can ask to send as anyone.
  const actingAddress: string | null = null
  const requestedActAs = body.actAs?.trim().toLowerCase()
  if (requestedActAs && requestedActAs !== account.address?.toLowerCase()) {
    return NextResponse.json(
      { ok: false, error: 'You can only send from your own address.' },
      { status: 403 },
    )
  }

  const fromAddress =
    actingAddress ?? account.address ?? process.env.MAIL_FROM ?? process.env.RESEND_FROM ?? BRAND.supportEmail

  // Sending to your own address loops the message back through the inbound
  // webhook and lands it in the mailbox it came from, which reads as a delivery
  // failure to the person who sent it. Refuse it outright.
  //
  // Checked against the address actually being sent from, not account.address: an
  // accessor with no address of their own still sends as the shared inbox, and
  // that send would loop just the same.
  const senderAddress = fromAddress.replace(/^.*<|>$/g, '').trim().toLowerCase()
  if (senderAddress) {
    const everyRecipient = [...recipients, ...(body.cc ?? []), ...(body.bcc ?? [])]
      .map(entry => String(entry).replace(/^.*<|>$/g, '').trim().toLowerCase())
    if (everyRecipient.includes(senderAddress)) {
      return NextResponse.json(
        { ok: false, error: 'You cannot send a message to your own address.' },
        { status: 400 },
      )
    }
  }

  if (!recipients.length) {
    return NextResponse.json({ ok: false, error: 'At least one recipient is required' }, { status: 400 })
  }
  if (!body.subject?.trim()) {
    return NextResponse.json({ ok: false, error: 'Subject is required' }, { status: 400 })
  }
  if (!body.html?.trim() && !body.text?.trim()) {
    return NextResponse.json({ ok: false, error: 'Email body is required' }, { status: 400 })
  }

  const rawAttachments = (body.attachments ?? []).filter(entry => entry.filename && (entry.content || entry.path || entry.key))
  if (rawAttachments.length && body.scheduledAt) {
    // Resend rejects attachments on scheduled sends — surface it before the API does.
    return NextResponse.json(
      { ok: false, error: 'Resend does not support attachments on scheduled emails — send now or drop the attachments' },
      { status: 400 },
    )
  }

  // Embed each attachment as base64 content. Resend fetches `path` URLs unreliably,
  // so we pull the blob server-side (no browser body limit) and hand Resend the bytes.
  let attachments: Array<{ filename: string; content: string }>
  try {
    attachments = await Promise.all(
      rawAttachments.map(async entry => {
        if (entry.content) return { filename: entry.filename, content: entry.content }

        // Attachments live in the bucket; the key is signed here rather than trusting a
        // URL from the client, so a caller cannot point this at somewhere it should not read.
        let source: URL
        if (entry.key) {
          if (!/^outgoing\/[a-f0-9]{18}\/[\w.\- ]{1,120}$/.test(entry.key)) {
            throw new Error(`Unsupported attachment source for ${entry.filename}`)
          }
          source = new URL(presign(entry.key, 'GET', 300))
        } else {
          source = new URL(entry.path!)
          if (source.protocol !== 'https:' || !source.hostname.endsWith('.public.blob.vercel-storage.com')) {
            throw new Error(`Unsupported attachment source for ${entry.filename}`)
          }
        }
        const response = await fetch(source)
        if (!response.ok) throw new Error(`Could not fetch attachment ${entry.filename}`)
        const buffer = Buffer.from(await response.arrayBuffer())
        return { filename: entry.filename, content: buffer.toString('base64') }
      }),
    )
  } catch (fetchError) {
    return NextResponse.json({ ok: false, error: (fetchError as Error).message }, { status: 502 })
  }

  const bareAddress = fromAddress.includes('<') ? fromAddress : `${BRAND.name} <${fromAddress}>`
  const from = body.fromName?.trim()
    ? `${body.fromName.trim().replace(/[<>"]/g, '')} <${bareAddress.replace(/^.*<|>$/g, '')}>`
    : bareAddress
  const replyTo = body.replyTo?.trim() || account.address || undefined

  // Open-tracking pixel: a 1x1 image whose load hits our endpoint, so we can tell
  // an HTML email was opened independently of Resend's own tracking.
  const origin = publicOrigin(req)
  const pixelId = randomUUID()
  const trackedHtml = body.html?.trim()
    ? `${body.html.trim()}<img src="${origin}/api/mail/pixel/${pixelId}" alt="" width="1" height="1" style="display:none;width:1px;height:1px;border:0" />`
    : null

  // Thread the reply: In-Reply-To/References point at the inbound Message-ID so the
  // recipient's client threads it, and so future replies chain back to this conversation.
  const inReplyToId = body.inReplyTo?.trim()
    ? `<${body.inReplyTo.trim().replace(/[<>]/g, '')}>`
    : null

  const fromEmail = from.replace(/^.*<|>$/g, '').trim()
  const fromName = from.includes('<') ? from.slice(0, from.indexOf('<')).replace(/["']/g, '').trim() : undefined

  let data: { id: string | null }
  try {
    data = await sendMail({
      from: fromEmail,
      fromName: fromName || undefined,
      to: recipients,
      cc: body.cc,
      bcc: body.bcc,
      replyTo,
      subject: body.subject.trim(),
      html: trackedHtml,
      text: body.text,
      scheduledAt: body.scheduledAt,
      attachments,
      ...(inReplyToId ? { headers: { 'In-Reply-To': inReplyToId, References: inReplyToId } } : {}),
    })
  } catch (sendError) {
    return NextResponse.json({ ok: false, error: (sendError as Error).message }, { status: 502 })
  }

  await Promise.all([
    ...[...recipients, ...(body.cc ?? []), ...(body.bcc ?? [])].map(address => recordContact(address, null).catch(() => {})),
    trackedHtml && data?.id
      ? recordPixel(pixelId, data.id, recipients[0] ?? '', body.subject.trim()).catch(() => {})
      : Promise.resolve(),
    data?.id ? recordSentMeta(data.id, account.address, false, body.inReplyTo ?? null).catch(() => {}) : Promise.resolve(),
    data?.id
      ? recordSentMessage({
          id: data.id,
          from,
          to: recipients,
          cc: body.cc ?? [],
          bcc: body.bcc ?? [],
          replyTo: replyTo ? [replyTo] : [],
          subject: body.subject!.trim(),
          html: trackedHtml,
          text: body.text ?? null,
          createdAt: new Date().toISOString(),
          // Recorded so the Sent folder and a forward read our own bucket rather than
          // the provider's, which keeps these only as long as it chooses to.
          attachments: rawAttachments
            .filter(entry => entry.key)
            .map(entry => ({ filename: entry.filename, key: entry.key })),
        }).catch(() => {})
      : Promise.resolve(),
  ])
  return NextResponse.json({ ok: true, id: data?.id, scheduledAt: body.scheduledAt ?? null })
}
