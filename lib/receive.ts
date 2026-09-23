import { BRAND, ADDRESS_DOMAINS } from '@/lib/brand'
import { sendPush } from '@/lib/push'
import { stripOwnPixel } from '@/lib/email-html'
import { FORWARDING_ENABLED, FORWARD_RECIPIENTS, MAIL_DOMAIN } from '@/lib/dev-auth'
import { ADDRESS_ALIASES, appendInbound, isDmarcAggregateReport, judgeMessage, noteSender, senderStanding, senderDomainOf, getAccountByAddress, inboundExists, recordContact, recordSentMeta, repairInbound } from '@/lib/mailbox'
import { sendMail } from '@/lib/mail-provider'

/**
 * Where the receiving API lives. The Resend SDK reads RESEND_BASE_URL for sending, so a
 * deployment pointed at another Resend-compatible host sends there — these calls are hand
 * rolled and have to honour the same variable, or receiving silently talks to a host that
 * has never seen the message and every body arrives empty.
 */
function receivingBase(): string {
  const configured = (process.env.RESEND_BASE_URL ?? '').trim().replace(/\/+$/, '')
  return configured || 'https://api.resend.com'
}

// The address we send from, and the inbox that owns mail addressed to nobody specific.
const MAIL_FROM = (process.env.MAIL_FROM ?? process.env.RESEND_FROM ?? BRAND.supportEmail).replace(/^.*<|>$/g, '').trim()
const SHARED_ADDRESS = MAIL_FROM.toLowerCase()

/** Attribute an inbound email to the accessor it was delivered to, else the shared inbox. */
export async function attributeOwner(recipients: string[]): Promise<string> {
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

/**
 * Whether any recipient is on a domain this deployment hosts. One provider account can
 * hold several tenants' domains and posts every message it receives to the one webhook it
 * is configured with, so a deployment is offered other tenants' mail as a matter of course
 * — and a signature check proves only that the provider sent it, not that it is ours.
 */
export function addressedToUs(recipients: string[]): boolean {
  const hosted = new Set([...ADDRESS_DOMAINS, MAIL_DOMAIN].map(domain => domain.trim().toLowerCase()).filter(Boolean))
  return recipients.some(raw => {
    const match = raw?.match(/<([^>]+)>/)
    const address = (match ? match[1] : raw ?? '').trim().toLowerCase()
    const domain = address.split('@')[1] ?? ''
    return domain !== '' && hosted.has(domain)
  })
}

export function parseSender(raw: string): { email: string; name: string | null } {
  const match = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (match) return { name: match[1].replace(/^"|"$/g, '') || null, email: match[2].trim() }
  return { name: null, email: raw.trim() }
}

function snippet(html: string | null, text: string | null): string {
  const source = text?.trim() || (html ?? '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  return source.replace(/\s+/g, ' ').trim().slice(0, 240)
}

function escapeHtml(src: string): string {
  return src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The addresses in a To or Cc header, bare, in the shape the provider already gives Cc.
 *
 * The provider's own `to` is the envelope recipient of the one copy it delivered, so every
 * mailbox on a message saw itself in the To line — a colleague copied in read as though the
 * client had written to them.
 */
export function headerAddresses(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : ''
  const entries: string[] = []
  let current = ''
  let quoted = false
  let angled = false
  let comment = 0
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if ((quoted || comment) && char === '\\') {
      current += char + (raw[index + 1] ?? '')
      index += 1
      continue
    }
    if (char === '"' && !comment) quoted = !quoted
    else if (!quoted && char === '(') comment += 1
    else if (!quoted && char === ')' && comment) comment -= 1
    else if (!quoted && !comment && char === '<') angled = true
    else if (!quoted && !comment && char === '>') angled = false
    if ((char === ',' || char === ';') && !quoted && !angled && !comment) {
      entries.push(current)
      current = ''
    } else current += char
  }
  entries.push(current)
  return entries
    .map(entry => entry.replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/\((?:[^()\\]|\\.)*\)/g, ' '))
    .map(entry => entry.replace(/^[^<]*?:/, ''))
    .map(entry => (entry.match(/<([^>]*)>/)?.[1] ?? entry).trim())
    .filter(address => /^[^\s@<>"()]+@[^\s@<>"()]+$/.test(address))
}

export type ReceivedEmail = {
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
export async function fetchReceivedEmail(emailId: string, apiKey: string): Promise<ReceivedEmail | null> {
  try {
    const response = await fetch(`${receivingBase()}/emails/receiving/${encodeURIComponent(emailId)}`, {
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

export type SendAttachment = { filename: string; content: string; contentType?: string; contentId?: string; size?: number }

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
    const response = await fetch(`${receivingBase()}/emails/receiving/${encodeURIComponent(emailId)}/attachments`, {
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
        // Inline base64 when the host sends the bytes with the listing; a download_url is
        // fetched only when it doesn't.
        if (entry.content) file.content = String(entry.content)
        else {
          const binary = url ? await fetch(url) : null
          if (binary?.ok) file.content = Buffer.from(await binary.arrayBuffer()).toString('base64')
        }
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
export async function forwardToAccounts(
  emailId: string,
  inbound: ReceivedEmail,
  ownerAddress: string | null,
  files?: SendAttachment[],
): Promise<void> {
  if (!FORWARDING_ENABLED || isDmarcAggregateReport(inbound.subject)) return
  const owningAccount = ownerAddress ? await getAccountByAddress(ownerAddress) : null
  const recipient = owningAccount?.email ?? FORWARD_RECIPIENTS[0] // fallback: the admin
  if (!recipient) return
  // Forwarding exists to put a copy somewhere the recipient already reads. Once a domain's
  // MX points here, an address on it is somewhere we read — so forwarding to one would
  // deliver back into this handler and forward again, without end. Every domain this
  // deployment receives counts, not just the primary one: an account on a secondary domain
  // forwards to itself once a minute until something outside gives up.
  const recipientDomain = recipient.trim().toLowerCase().split('@')[1] ?? ''
  if (recipientDomain === MAIL_DOMAIN || ADDRESS_DOMAINS.includes(recipientDomain)) return
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
      // The archive already holds the message this forwards; a second copy is noise.
      skipArchive: true,
      text: inbound.text?.trim() || snippet(inbound.html, inbound.text) || ' ',
      ...(inbound.html ? { html: `${header}${stripOwnPixel(inbound.html)}` } : {}),
      ...(attachments.length ? { attachments } : {}),
    })
    // Tag as automated so this "Fwd:" copy never shows up in the Sent folder.
    if (data?.id) await recordSentMeta(data.id, null, true).catch(() => {})
  } catch (err) {
    console.warn('[mail] inbound forward failed:', err)
  }
}

/**
 * Everything that has to happen when the provider hands us a received message, from the
 * webhook or from a later reconciliation by id. The claim around it belongs to the caller:
 * the webhook keys it on the delivery id, a re-run on the message id.
 */
export async function ingestReceived(
  emailId: string,
  data: Record<string, unknown> = {},
  /**
   * Repairing a message already in the mailbox: fill in the body and attachments it was
   * stored without, and stop there. The owner was notified and the copy forwarded when it
   * first arrived, so doing either again would be a second delivery of old mail.
   */
  mode: 'store' | 'repair' = 'store',
): Promise<{ owner: string; subject: string; from: string }> {
  const apiKey = process.env.RESEND_API_KEY
  // The webhook payload has no body — pull the full email (html/text/attachments) from Resend.
  const full = apiKey ? await fetchReceivedEmail(emailId, apiKey) : null

  const payloadAttachments = Array.isArray(data.attachments) ? (data.attachments as Array<Record<string, unknown>>) : []
  // The sender's own domain answers these, and the provider scans for spam and viruses
  // before we ever see the message. Where the webhook does not carry a verdict, the
  // Authentication-Results header the receiving server wrote does.
  const authHeader = String(
    (full?.headers as Record<string, unknown> | undefined)?.['authentication-results'] ?? '',
  ).toLowerCase()
  const fromHeader = (mech: string): string | null => authHeader.match(new RegExp(`${mech}=(\\w+)`))?.[1] ?? null

  // Who this is for has to be settled before the message can be judged: standing is what
  // this mailbox has done with this sender, and a different mailbox may have done the
  // opposite. Resolved once here and reused below.
  const recipients = [
    ...(Array.isArray(full?.to) ? full!.to : []),
    ...(Array.isArray(data.to) ? (data.to as string[]) : [String(data.to ?? '')]),
    ...(Array.isArray(full?.cc) ? full!.cc : []),
    ...(Array.isArray(data.cc) ? (data.cc as string[]) : []),
    ...(Array.isArray(full?.bcc) ? full!.bcc : []),
    ...(Array.isArray(data.bcc) ? (data.bcc as string[]) : []),
  ].filter(Boolean)
  const owner = await attributeOwner(recipients)
  const toHeader = (full?.headers as Record<string, unknown> | undefined)?.to
  const fromAddress = full?.from || String(data.from ?? '')
  const senderDomain = senderDomainOf(fromAddress)
  const standing = await senderStanding(owner, senderDomain)

  const verdicts = judgeMessage({
    spam: data.spam == null ? null : String(data.spam),
    virus: data.virus == null ? null : String(data.virus),
    // Where no provider hands us a verdict — a deployment reading its mail through Resend,
    // say — the receiving server's own Authentication-Results header carries the same answer.
    spf: data.spf == null ? fromHeader('spf') : String(data.spf),
    dkim: data.dkim == null ? fromHeader('dkim') : String(data.dkim),
    dmarc: data.dmarc == null ? fromHeader('dmarc') : String(data.dmarc),
    from: full?.from || String(data.from ?? ''),
    replyTo: full?.replyTo ?? (Array.isArray(data.reply_to) ? (data.reply_to as string[]) : []),
    subject: full?.subject || String(data.subject ?? ''),
    text: full?.text ?? (data.text ? String(data.text) : null),
  }, standing)
  if (verdicts.risk !== 'clean') {
    console.warn(`[mail] ${verdicts.risk} inbound ${emailId}:`, verdicts.reasons.join('; '))
  }

  const inbound = {
    id: emailId,
    risk: verdicts.risk,
    riskReasons: verdicts.reasons,
    // Held out of the inbox, not merely labelled, once the weight passes the threshold.
    spam: verdicts.quarantine,
    from: full?.from || String(data.from ?? ''),
    to: toHeader !== undefined || Object.keys(full?.headers ?? {}).length
      ? headerAddresses(toHeader)
      : full?.to ?? (Array.isArray(data.to) ? (data.to as string[]) : [String(data.to ?? '')]),
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
    owner,
  }
  // Refuse mail that was never addressed to this mailbox, before a copy is stored, pushed
  // or forwarded. Without this, every message the provider account receives for any tenant
  // lands in whichever deployment holds the webhook, filed to its shared inbox because no
  // local account matches — one tenant reading another's mail.
  if (!addressedToUs(recipients)) {
    throw new Error(`refusing ${emailId}: addressed to ${recipients.join(', ') || 'nobody'}, which is not a domain this mailbox hosts`)
  }

  // Pull the bytes once: they become our stored copy and the forward's attachments.
  const files = apiKey ? await fetchAttachmentBytes(emailId, apiKey) : []
  if (files.length) inbound.attachments = await rehostAttachments(emailId, files)
  const forwardable = files.filter(file => file.content)

  if (mode === 'repair') {
    if (!full) throw new Error('provider returned no body; nothing to repair with')
    const filled = await repairInbound(inbound)
    if (!filled) throw new Error('no such message in this mailbox')
    return { owner: inbound.owner, subject: inbound.subject, from: inbound.from }
  }

  await appendInbound(inbound)
  await noteSender(owner, senderDomain, 'received').catch(() => {})
  const sender = parseSender(inbound.from)
  await recordContact(sender.email, sender.name)
  if (!isDmarcAggregateReport(inbound.subject)) {
    await sendPush(inbound.owner, {
      title: sender.name || sender.email || 'New mail',
      body: inbound.subject,
      tag: emailId,
    }).catch(() => {})
  }
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
  return { owner: inbound.owner, subject: inbound.subject, from: inbound.from }
}

export type ReceivedSummary = { id: string; from: string; to: string[]; subject: string; createdAt: string }

/**
 * Everything the provider has received for this account since `since`, newest first. The
 * provider keeps this list, which is what makes a missed delivery recoverable at all: the
 * webhook is a nudge, the list is the record.
 */
export async function listReceived(apiKey: string, since: Date): Promise<ReceivedSummary[]> {
  const out: ReceivedSummary[] = []
  let after: string | null = null
  for (let page = 0; page < 200; page += 1) {
    const params = new URLSearchParams({ limit: '50' })
    if (after) params.set('after', after)
    const response = await fetch(`${receivingBase()}/emails/receiving?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`provider list failed (${response.status})`)
    const body = (await response.json()) as { data?: Array<Record<string, unknown>>; has_more?: boolean }
    const items = body.data ?? []
    if (!items.length) break
    let reachedSince = false
    for (const item of items) {
      const createdAt = String(item.created_at ?? '')
      if (createdAt && new Date(createdAt) < since) { reachedSince = true; break }
      out.push({
        id: String(item.id),
        from: String(item.from ?? ''),
        to: Array.isArray(item.to) ? (item.to as string[]) : [],
        subject: String(item.subject ?? ''),
        createdAt,
      })
    }
    if (reachedSince || !body.has_more) break
    const last = String(items[items.length - 1].id)
    if (last === after) break
    after = last
  }
  return out
}

/** Received by the provider for an address on this tenant's domain, but absent from the mailbox. */
export async function findMissingReceived(apiKey: string, since: Date): Promise<ReceivedSummary[]> {
  const received = await listReceived(apiKey, since)
  const ours = received.filter(item =>
    item.to.some(address => address.trim().toLowerCase().endsWith(`@${MAIL_DOMAIN}`)),
  )
  const present = await inboundExists(ours.map(item => item.id))
  return ours.filter(item => !present.has(item.id))
}
