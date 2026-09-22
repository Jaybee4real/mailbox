import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { mailAuthGuard, isLocalOrigin, resolveAccount } from '@/lib/dev-auth'
import { scopeFor } from '@/lib/scope'
import { searchInbox, appendEvent, appendInbound, recordContact, setInboundFlags, setInboundFlagsForThread, setInboundLabels, setThreadSnooze, setInboxOwner, readInbox, claimWebhookEvent, completeWebhookEvent, releaseWebhookEvent, pruneWebhookEvents, type InboundFlags } from '@/lib/mailbox'
import { addressedToUs, attributeOwner, forwardToAccounts, ingestReceived, parseSender } from '@/lib/receive'
import { isBrevoInbound, normalizeBrevoInbound } from '@/lib/mail-provider'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  // Everyone sees their own mailbox and only their own, unless this deployment names one
  // address that reads every account. Administering accounts stays a separate power.
  const ownerFilter = scopeFor(account, new URL(req.url).searchParams.get('mailbox'))
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
      owner: ownerFilter ?? undefined,
      folder,
      limit: Number(limitRaw ?? 50) || 50,
      offset,
      cursor,
      // Counting scans the whole match. Unfiltered, the sidebar already has this number
      // from countFolders, so only a search — whose match nothing else knows — pays for it.
      threadId,
      withTotal: !cursor && Boolean(text || params.get('from') || params.get('to') || params.get('label') || params.get('unread') || params.get('starred') || params.get('attachment')),
      unread: params.get('unread') === '1' ? true : undefined,
      starred: params.get('starred') === '1' ? true : undefined,
      hasAttachment: params.get('attachment') === '1' || undefined,
      label: params.get('label') ?? undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      addressed: params.get('addressed') ?? undefined,
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
        if ((await claimWebhookEvent(deliveryId)) !== 'claimed') continue
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
    // The signature proves the provider sent it, not that it is ours. One provider account
    // can hold several tenants' domains and posts all of their mail to the single webhook
    // it knows about, so anything addressed elsewhere is acknowledged and dropped — a 2xx
    // rather than an error, because retrying will never make it ours.
    const addressed = [
      ...(Array.isArray(data.to) ? (data.to as string[]) : [String(data.to ?? '')]),
      ...(Array.isArray(data.cc) ? (data.cc as string[]) : []),
      ...(Array.isArray(data.bcc) ? (data.bcc as string[]) : []),
    ].filter(Boolean)
    if (addressed.length && !addressedToUs(addressed)) {
      console.warn('[mail] refused inbound for another tenant', { emailId, to: addressed })
      return NextResponse.json({ ok: true, ignored: 'not addressed to this mailbox' })
    }
    // Keyed on the delivery id, which a retry reuses, so a redelivery of something we
    // already finished is a no-op rather than a second forwarded copy.
    const deliveryId = req.headers.get('svix-id') || `received:${emailId}`
    const claim = await claimWebhookEvent(deliveryId)
    if (claim === 'done') return NextResponse.json({ ok: true, duplicate: true })
    if (claim === 'busy') {
      // A 2xx here ends the provider's retries. Another attempt still holds this delivery;
      // if it dies, the lease expires and the next retry takes over — so ask for one.
      return NextResponse.json({ ok: false, error: 'Delivery is being handled; retry shortly' }, { status: 409 })
    }
    try {
      await ingestReceived(emailId, data)
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
