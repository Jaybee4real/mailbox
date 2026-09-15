import { BRAND } from '@/lib/brand'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { sendPush } from '@/lib/push'
import { FORWARD_RECIPIENTS, MAIL_DOMAIN, mailAuthGuard, isLocalOrigin, resolveAccount } from '@/lib/dev-auth'
import { ADDRESS_ALIASES, searchInbox, appendEvent, appendInbound, recordContact, recordSentMeta, getAccountByAddress, setInboundFlags, setInboundFlagsForThread, setInboundLabels, setThreadSnooze, setInboxOwner, readInbox, claimWebhookEvent, completeWebhookEvent, releaseWebhookEvent, pruneWebhookEvents, type InboundFlags } from '@/lib/mailbox'
import { isBrevoInbound, normalizeBrevoInbound, sendMail } from '@/lib/mail-provider'

// The address we send from, and the inbox that owns mail addressed to nobody specific.
const MAIL_FROM = (process.env.MAIL_FROM ?? process.env.RESEND_FROM ?? BRAND.supportEmail).replace(/^.*<|>$/g, '').trim()
const SHARED_ADDRESS = MAIL_FROM.toLowerCase()

/** Attribute an inbound email to the accessor it was delivered to, else the shared inbox. */
async function attributeOwner(recipients: string[]): Promise<string> {
  for (const raw of recipients) {
    const match = raw.match(/<([^>]+)>/)
    const addr = (match ? match[1] : raw).trim().toLowerCase()
    if (!addr.includes('@')) continue
    const account = await getAccountByAddress(addr)
    if (account?.address) {
      const owner = account.address.toLowerCase()
      return ADDRESS_ALIASES[owner] ?? owner
    }
  }
  return SHARED_ADDRESS
}

function parseSender(raw: string): { email: string; name: string | null } {
  const match = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (match) return { name: match[1].replace(/^"|"$/g, '') || null, email: match[2].trim() }
  return { name: null, email: raw.trim() }
}

export const runtime = 'nodejs'

function snippet(html: string | null, text: string | null): string {
  const source = text?.trim() || (html ?? '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  return source.replace(/\s+/g, ' ').trim().slice(0, 240)
}

function escapeHtml(src: string): string {
  return src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

type ReceivedEmail = {
  html: string | null
  text: string | null
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo: string[]
  subject: string
  headers: Record<string, unknown>
  createdAt: string
  attachments: Array<{ filename: string; contentType?: string }>
}

// The email.received webhook payload carries only metadata (from/to/subject) — the body
// lives on Resend and must be pulled from the receiving endpoint, or the inbox stores blanks.
async function fetchReceivedEmail(emailId: string, apiKey: string): Promise<ReceivedEmail | null> {
  try {
    const response = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) return null
    const data = (await response.json()) as Record<string, unknown>
    const rawAttachments = Array.isArray(data.attachments) ? (data.attachments as Array<Record<string, unknown>>) : []
    return {
      html: data.html ? String(data.html) : null,
      text: data.text ? String(data.text) : null,
      from: String(data.from ?? ''),
      to: Array.isArray(data.to) ? (data.to as string[]) : [String(data.to ?? '')],
      cc: Array.isArray(data.cc) ? (data.cc as string[]) : [],
      bcc: Array.isArray(data.bcc) ? (data.bcc as string[]) : [],
      replyTo: Array.isArray(data.reply_to) ? (data.reply_to as string[]) : [],
      subject: String(data.subject ?? '(no subject)'),
      headers: data.headers && typeof data.headers === 'object' ? (data.headers as Record<string, unknown>) : {},
      createdAt: String(data.created_at ?? new Date().toISOString()),
      attachments: rawAttachments
        .map(entry => ({
          filename: String(entry.filename ?? entry.name ?? 'attachment'),
          contentType: entry.content_type ? String(entry.content_type) : undefined,
        }))
        .filter(entry => entry.filename),
    }
  } catch {
    return null
  }
}

type SendAttachment = { filename: string; content: string; contentType?: string; contentId?: string; size?: number }

/**
 * Copy attachment bytes onto our own storage as the message arrives. Provider download URLs
 * expire and disappear with the account, so a stored filename alone would outlive the file.
 */
async function rehostAttachments(
  emailId: string,
  files: SendAttachment[],
): Promise<Array<{ filename: string; contentType?: string; key?: string; size?: number; contentId?: string }>> {
  if (!files.length) return []
  const { putObject } = await import('@/lib/r2')
  return Promise.all(
    files.map(async (file, index) => {
      if (!file.content) {
        return { filename: file.filename, contentType: file.contentType, size: file.size, contentId: file.contentId }
      }
      const bytes = Buffer.from(file.content, 'base64')
      // contentId is what separates an embedded signature image from a real attachment.
      const meta = { filename: file.filename, contentType: file.contentType, size: bytes.length, contentId: file.contentId }
      const safeName = (file.filename || 'attachment').replace(/[^\w.\- ]+/g, '_').slice(-120)
      const key = `attachments/${emailId}/${index}-${safeName}`
      // Written to our own bucket and served back through this domain. The provider's
      // own link expires, dies with the account, and points at a host outside our
      // control; the bucket URL would be a third host again, so neither is handed out.
      return (await putObject(key, bytes, file.contentType)) ? { ...meta, key } : meta
    }),
  )
}

async function fetchAttachmentBytes(emailId: string, apiKey: string): Promise<SendAttachment[]> {
  try {
    const response = await fetch(`https://api.resend.com/emails/receiving/${emailId}/attachments`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) return []
    const data = (await response.json()) as { data?: Array<Record<string, unknown>> }
    const list = Array.isArray(data.data) ? data.data : []
    const out: SendAttachment[] = []
    for (const entry of list) {
      const url = entry.download_url ? String(entry.download_url) : ''
      const file: SendAttachment = {
        filename: String(entry.filename ?? 'attachment'),
        content: '',
        contentType: entry.content_type ? String(entry.content_type) : undefined,
        contentId: entry.content_id ? String(entry.content_id).replace(/^<|>$/g, '') : undefined,
        size: Number(entry.size ?? 0) || undefined,
      }
      try {
        const binary = url ? await fetch(url) : null
        if (binary?.ok) file.content = Buffer.from(await binary.arrayBuffer()).toString('base64')
      } catch (err) {
        console.warn(`[mail] attachment pull failed for ${emailId}/${file.filename}:`, err)
      }
      out.push(file)
    }
    return out
  } catch {
    return []
  }
}

// Forward the whole received email — full body + attachments — to the mail accounts.
// Forward the inbound copy ONLY to the account that owns the mail (its login email),
// never to every accessor — a member must not receive mail that isn't theirs.
async function forwardToAccounts(
  emailId: string,
  inbound: ReceivedEmail,
  ownerAddress: string | null,
  files?: SendAttachment[],
): Promise<void> {
  const owningAccount = ownerAddress ? await getAccountByAddress(ownerAddress) : null
  const recipient = owningAccount?.email ?? FORWARD_RECIPIENTS[0] // fallback: the admin
  if (!recipient) return
  // Forwarding exists to put a copy somewhere the recipient already reads. Once this
  // domain's MX points here, an address on it is somewhere we read — so forwarding to
  // one would deliver back into this handler and forward again, without end.
  if (recipient.trim().toLowerCase().endsWith(`@${MAIL_DOMAIN}`)) return
  const from = MAIL_FROM
  // Attachment bytes only come from Resend's receiving API; under another provider the
  // forward still goes out, just without re-attaching the files.
  const resendKey = process.env.RESEND_API_KEY
  const attachments = (files ?? (resendKey ? await fetchAttachmentBytes(emailId, resendKey) : [])).filter(file => file.content)
  const header = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5A5170;border-left:3px solid ${BRAND.colors.accent};padding:4px 0 4px 12px;margin:0 0 16px;">---------- Forwarded message ----------<br><strong>From:</strong> ${escapeHtml(inbound.from)}<br><strong>Subject:</strong> ${escapeHtml(inbound.subject)}</div>`
  try {
    const data = await sendMail({
      from: from.replace(/^.*<|>$/g, ''),
      fromName: `${BRAND.name} Mail`,
      to: [recipient],
      replyTo: inbound.from || undefined,
      subject: inbound.subject.startsWith('Fwd:') ? inbound.subject : `Fwd: ${inbound.subject}`,
      text: inbound.text?.trim() || snippet(inbound.html, inbound.text) || ' ',
      ...(inbound.html ? { html: `${header}${inbound.html}` } : {}),
      ...(attachments.length ? { attachments } : {}),
    })
    // Tag as automated so this "Fwd:" copy never shows up in the Sent folder.
    if (data?.id) await recordSentMeta(data.id, null, true).catch(() => {})
  } catch (err) {
    console.warn('[mail] inbound forward failed:', err)
  }
}

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  // Everyone sees their own mailbox and only their own. Administering accounts is a
  // separate power from reading other people's mail, so an admin is scoped here too.
  const ownerFilter: string = account.address ?? ' no-address'
  // A query or an explicit page means the caller wants the searchable, paged path.
  // Without either, fall back to readInbox so existing callers are unaffected.
  const params = new URL(req.url).searchParams
  const text = params.get('q')?.trim()
  const limitRaw = params.get('limit')
  const offset = Number(params.get('offset') ?? 0) || 0

  const cursor = params.get('cursor')

  const threadId = params.get('thread') ?? undefined
  if (text || limitRaw || offset || cursor || threadId) {
    const folderParam = params.get('folder')
    const folder = (['inbox', 'archive', 'trash', 'starred', 'snoozed'] as const).find(f => f === folderParam)
    const { rows, total, nextCursor } = await searchInbox({
      text,
      owner: ownerFilter,
      folder,
      limit: Number(limitRaw ?? 50) || 50,
      offset,
      cursor,
      // Counting scans the whole match. Unfiltered, the sidebar already has this number
      // from countFolders, so only a search — whose match nothing else knows — pays for it.
      threadId,
      withTotal: !cursor && Boolean(text),
      unread: params.get('unread') === '1' ? true : undefined,
      starred: params.get('starred') === '1' ? true : undefined,
      hasAttachment: params.get('attachment') === '1' || undefined,
      label: params.get('label') ?? undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
    })
    return NextResponse.json({ ok: true, emails: rows, total, offset, nextCursor })
  }

  const emails = await readInbox(ownerFilter ? { owner: ownerFilter } : undefined)
  return NextResponse.json({ ok: true, emails })
}

export async function PATCH(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  let body: { id?: string; ids?: string[]; threadId?: string; labels?: string[]; owner?: string; snoozedUntil?: string | null } & InboundFlags
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const ids = body.ids ?? (body.id ? [body.id] : [])
  if (!ids.length && !body.threadId) {
    return NextResponse.json({ ok: false, error: 'id, ids or threadId is required' }, { status: 400 })
  }

  // Snooze belongs to the conversation, so it is set by thread and nothing else.
  if (body.snoozedUntil !== undefined) {
    if (!body.threadId) {
      return NextResponse.json({ ok: false, error: 'snoozedUntil needs a threadId' }, { status: 400 })
    }
    const until = body.snoozedUntil
    if (until !== null && Number.isNaN(Date.parse(until))) {
      return NextResponse.json({ ok: false, error: 'snoozedUntil must be a date or null' }, { status: 400 })
    }
    const account = await resolveAccount(req)
    const moved = await setThreadSnooze(
      account.address ?? ' no-address',
      body.threadId,
      until === null ? null : new Date(until).toISOString(),
    )
    return NextResponse.json({ ok: true, messages: moved })
  }
  // Reassigning inbound mail to a mailbox is admin-only.
  if (body.owner !== undefined) {
    const account = await resolveAccount(req)
    if (account.role !== 'admin') {
      return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 })
    }
    await Promise.all(ids.map(id => setInboxOwner(id, body.owner!)))
    return NextResponse.json({ ok: true })
  }
  if (Array.isArray(body.labels)) {
    const labels = body.labels.map(String)
    await Promise.all(ids.map(id => setInboundLabels(id, labels)))
    return NextResponse.json({ ok: true })
  }
  const flags: InboundFlags = {}
  if (body.read !== undefined) flags.read = body.read
  if (body.starred !== undefined) flags.starred = body.starred
  if (body.archived !== undefined) flags.archived = body.archived
  if (body.trashed !== undefined) flags.trashed = body.trashed
  if (!Object.keys(flags).length) flags.read = true
  if (body.threadId) {
    const account = await resolveAccount(req)
    const changed = await setInboundFlagsForThread(account.address ?? ' no-address', body.threadId, flags)
    return NextResponse.json({ ok: true, ids: changed })
  }
  await Promise.all(ids.map(id => setInboundFlags(id, flags)))
  return NextResponse.json({ ok: true, ids })
}

// Svix signature scheme used by Resend webhooks: HMAC-SHA256 over `${id}.${timestamp}.${payload}`
// with the base64-decoded secret after the `whsec_` prefix.
const SIGNATURE_MAX_AGE_MS = 48 * 60 * 60 * 1000

function verifyWebhookSignature(req: Request, payload: string): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  // No secret configured: allow only local development, never unsigned prod posts.
  if (!secret) return isLocalOrigin(req)
  const svixId = req.headers.get('svix-id') ?? ''
  const svixTimestamp = req.headers.get('svix-timestamp') ?? ''
  const svixSignature = req.headers.get('svix-signature') ?? ''
  if (!svixId || !svixTimestamp || !svixSignature) return false

  // Wide on purpose. Duplicate suppression is the delivery-id claim, not this window,
  // because a provider's retry schedule runs for hours and a tight window here would
  // throw away the redelivery of a message we never managed to store. This only stops
  // a captured request being replayed indefinitely.
  const sentAt = Number(svixTimestamp) * 1000
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > SIGNATURE_MAX_AGE_MS) return false

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key)
    .update(`${svixId}.${svixTimestamp}.${payload}`)
    .digest('base64')

  return svixSignature.split(' ').some(part => {
    const candidate = part.split(',')[1] ?? ''
    try {
      return (
        candidate.length === expected.length &&
        timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
      )
    } catch {
      return false
    }
  })
}

/**
 * Brevo inbound parsing has no signature scheme, so the webhook URL carries a shared
 * secret: .../api/mail/inbox?secret=… — treated as a bearer token.
 */
function verifyBrevoSecret(req: Request): boolean {
  const expected = process.env.BREVO_WEBHOOK_SECRET
  if (!expected) return isLocalOrigin(req)
  const provided = new URL(req.url).searchParams.get('secret') ?? ''
  if (provided.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function POST(req: Request) {
  const payload = await req.text()

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(payload)
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  // ── Brevo inbound parsing ──────────────────────────────────────
  if (isBrevoInbound(parsed)) {
    if (!verifyBrevoSecret(req)) {
      return NextResponse.json({ ok: false, error: 'Invalid secret' }, { status: 401 })
    }
    const items = Array.isArray((parsed as { items?: unknown[] }).items)
      ? ((parsed as { items: Record<string, unknown>[] }).items)
      : [parsed]
    let stored = 0
    for (const item of items) {
      let deliveryId = ''
      try {
        const message = normalizeBrevoInbound(item)
        // Brevo carries no delivery id, so the message id stands in: a replayed batch
        // must not forward a second copy of mail already handled.
        deliveryId = `brevo:${message.id}`
        if (!(await claimWebhookEvent(deliveryId))) continue
        const owner = await attributeOwner([...message.to, ...message.cc, ...message.bcc])
        await appendInbound({ ...message, read: false, owner })
        const sender = parseSender(message.from)
        await recordContact(sender.email, sender.name).catch(() => {})
        await forwardToAccounts(
          message.id,
          {
            html: message.html,
            text: message.text,
            from: message.from,
            to: message.to,
            cc: message.cc,
            bcc: message.bcc,
            replyTo: message.replyTo,
            subject: message.subject,
            headers: message.headers,
            createdAt: message.receivedAt,
            attachments: message.attachments,
          },
          owner,
        )
        await completeWebhookEvent(deliveryId)
        stored++
      } catch (err) {
        await releaseWebhookEvent(deliveryId)
        console.warn('[mail] brevo inbound item failed:', err)
      }
    }
    return NextResponse.json({ ok: true, stored })
  }

  // ── Resend webhook ─────────────────────────────────────────────
  if (!verifyWebhookSignature(req, payload)) {
    return NextResponse.json({ ok: false, error: 'Invalid signature' }, { status: 401 })
  }
  const event = parsed as { type?: string; data?: Record<string, unknown> }

  const type = event.type ?? ''
  const data = event.data
  if (!type || !data) {
    return NextResponse.json({ ok: true, ignored: true })
  }

  if (type === 'email.received') {
    const emailId = String(data.email_id ?? data.id ?? `in_${Date.now()}`)
    // Keyed on the delivery id, which a retry reuses, so a redelivery of something we
    // already finished is a no-op rather than a second forwarded copy.
    const deliveryId = req.headers.get('svix-id') || `received:${emailId}`
    if (!(await claimWebhookEvent(deliveryId))) {
      return NextResponse.json({ ok: true, duplicate: true })
    }
    try {
    const apiKey = process.env.RESEND_API_KEY
    // The webhook payload has no body — pull the full email (html/text/attachments) from Resend.
    const full = apiKey ? await fetchReceivedEmail(emailId, apiKey) : null

    const payloadAttachments = Array.isArray(data.attachments) ? (data.attachments as Array<Record<string, unknown>>) : []
    const inbound = {
      id: emailId,
      from: full?.from || String(data.from ?? ''),
      to: full?.to ?? (Array.isArray(data.to) ? (data.to as string[]) : [String(data.to ?? '')]),
      cc: full?.cc ?? (Array.isArray(data.cc) ? (data.cc as string[]) : []),
      bcc: full?.bcc ?? (Array.isArray(data.bcc) ? (data.bcc as string[]) : []),
      replyTo: full?.replyTo ?? (Array.isArray(data.reply_to) ? (data.reply_to as string[]) : []),
      subject: full?.subject || String(data.subject ?? '(no subject)'),
      html: full?.html ?? (data.html ? String(data.html) : null),
      text: full?.text ?? (data.text ? String(data.text) : null),
      headers: full?.headers ?? {},
      receivedAt: full?.createdAt || String(data.created_at ?? new Date().toISOString()),
      read: false,
      attachments:
        full?.attachments ??
        payloadAttachments
          .map(entry => ({
            filename: String(entry.filename ?? entry.name ?? 'attachment'),
            contentType: entry.content_type ? String(entry.content_type) : undefined,
          }))
          .filter(entry => entry.filename),
      // Attribute (and therefore forward) to the accessor actually addressed — to, cc, OR bcc.
      // Anything not matching a member's personal address stays in the shared (admin) inbox,
      // so a member never receives mail they aren't a party to.
      owner: await attributeOwner([
        ...(Array.isArray(full?.to) ? full!.to : []),
        ...(Array.isArray(data.to) ? (data.to as string[]) : [String(data.to ?? '')]),
        ...(full?.cc ?? []),
        ...(full?.bcc ?? []),
      ]),
    }
    // Pull the bytes once: they become our stored copy and the forward's attachments.
    const files = apiKey ? await fetchAttachmentBytes(emailId, apiKey) : []
    if (files.length) inbound.attachments = await rehostAttachments(emailId, files)
    const forwardable = files.filter(file => file.content)

    await appendInbound(inbound)
    const sender = parseSender(inbound.from)
    await recordContact(sender.email, sender.name)
    await sendPush(inbound.owner, {
      title: sender.name || sender.email || 'New mail',
      body: inbound.subject,
      tag: emailId,
    }).catch(() => {})
    await forwardToAccounts(
      emailId,
      full ?? {
        html: inbound.html,
        text: inbound.text,
        from: inbound.from,
        to: inbound.to,
        cc: inbound.cc,
        bcc: inbound.bcc,
        replyTo: inbound.replyTo,
        subject: inbound.subject,
        headers: inbound.headers,
        createdAt: inbound.receivedAt,
        attachments: inbound.attachments,
      },
      inbound.owner,
      forwardable,
    )
    } catch (err) {
      // Give the id back so the provider's retry is allowed to redo the work.
      await releaseWebhookEvent(deliveryId)
      throw err
    }
    await completeWebhookEvent(deliveryId)
    void pruneWebhookEvents().catch(() => {})
    return NextResponse.json({ ok: true })
  }

  const meta: Record<string, string> = {}
  if (data.subject) meta.subject = String(data.subject)
  if (data.to) meta.to = Array.isArray(data.to) ? (data.to as string[]).join(', ') : String(data.to)
  const click = data.click as Record<string, unknown> | undefined
  if (click?.link) meta.link = String(click.link)
  const bounce = data.bounce as Record<string, unknown> | undefined
  if (bounce?.type) meta.bounceType = String(bounce.type)
  if (bounce?.message) meta.bounceMessage = String(bounce.message)
  const failed = data.failed as Record<string, unknown> | undefined
  if (failed?.reason) meta.failReason = String(failed.reason)
  if (type.startsWith('contact.') || type.startsWith('domain.')) {
    if (data.email) meta.contact = String(data.email)
    if (data.name) meta.name = String(data.name)
  }

  await appendEvent({
    emailId: String(data.email_id ?? ''),
    type,
    at: String(data.created_at ?? new Date().toISOString()),
    meta: Object.keys(meta).length ? meta : undefined,
  })
  return NextResponse.json({ ok: true })
}
