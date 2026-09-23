/**
 * One seam between the app and whichever email vendor is in use. Everything above this
 * file speaks these types; everything vendor-specific lives below. Switching providers
 * is then a config change plus one adapter, not a rewrite.
 *
 * Selected with MAIL_PROVIDER=ses|brevo|resend (defaults to resend so nothing changes
 * until the switch is deliberate).
 */

import { randomBytes } from 'node:crypto'
import { sesConfigured, sesSendRaw } from './ses-send'

export type MailProvider = 'resend' | 'brevo' | 'ses'

export type SendAttachment = { filename: string; content: string; contentType?: string }

export type SendPayload = {
  from: string
  fromName?: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  replyTo?: string
  subject: string
  html?: string | null
  text?: string | null
  headers?: Record<string, string>
  scheduledAt?: string
  attachments?: SendAttachment[]
  /** Set on copies that are themselves relays of mail we already hold. */
  skipArchive?: boolean
}

export type SendResult = { id: string | null }

/** Provider-neutral shape of a received message, matching what the inbox stores. */
export type NormalizedInbound = {
  id: string
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo: string[]
  subject: string
  html: string | null
  text: string | null
  headers: Record<string, unknown>
  receivedAt: string
  attachments: Array<{ filename: string; contentType?: string; url?: string; size?: number }>
}

export function activeProvider(): MailProvider {
  const configured = process.env.MAIL_PROVIDER
  if (configured === 'brevo' || configured === 'ses') return configured
  return 'resend'
}

/**
 * What the configured provider is still missing, or null when it can send. Callers used to
 * ask for RESEND_API_KEY directly, which refused every send on a deployment that had
 * deliberately chosen SES or Brevo.
 */
export function providerConfigProblem(): string | null {
  switch (activeProvider()) {
    case 'ses':
      return sesConfigured() ? null : 'SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY are not configured'
    case 'brevo':
      return process.env.BREVO_API_KEY ? null : 'BREVO_API_KEY is not configured'
    default:
      return process.env.RESEND_API_KEY ? null : 'RESEND_API_KEY is not configured'
  }
}

function splitAddress(raw: string): { email: string; name?: string } {
  const match = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (match) return { email: match[2].trim(), name: match[1].replace(/^"|"$/g, '') || undefined }
  return { email: raw.trim() }
}

// ── Sending ─────────────────────────────────────────────────────
async function sendViaResend(payload: SendPayload): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured')
  const { Resend } = await import('resend')
  const resend = new Resend(apiKey)
  const from = payload.fromName ? `${payload.fromName} <${payload.from}>` : payload.from
  const { data, error } = await resend.emails.send({
    from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text?.trim() || ' ',
    ...(payload.html ? { html: payload.html } : {}),
    ...(payload.cc?.length ? { cc: payload.cc } : {}),
    ...(payload.bcc?.length ? { bcc: payload.bcc } : {}),
    ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
    ...(payload.scheduledAt ? { scheduledAt: payload.scheduledAt } : {}),
    ...(payload.attachments?.length ? { attachments: payload.attachments.map(a => ({ filename: a.filename, content: a.content })) } : {}),
    ...(payload.headers ? { headers: payload.headers } : {}),
  })
  if (error) throw new Error(error.message)
  return { id: data?.id ?? null }
}

async function sendViaBrevo(payload: SendPayload): Promise<SendResult> {
  const apiKey = process.env.BREVO_API_KEY
  if (!apiKey) throw new Error('BREVO_API_KEY is not configured')
  // Brevo has no scheduling on the transactional endpoint we use; the caller decides
  // whether to hold the message instead of silently sending it now.
  if (payload.scheduledAt) throw new Error('Scheduled sending is not supported on Brevo')

  const body: Record<string, unknown> = {
    sender: { email: payload.from, ...(payload.fromName ? { name: payload.fromName } : {}) },
    to: payload.to.map(splitAddress),
    subject: payload.subject,
    ...(payload.html ? { htmlContent: payload.html } : {}),
    ...(payload.text?.trim() ? { textContent: payload.text.trim() } : {}),
    ...(payload.cc?.length ? { cc: payload.cc.map(splitAddress) } : {}),
    ...(payload.bcc?.length ? { bcc: payload.bcc.map(splitAddress) } : {}),
    ...(payload.replyTo ? { replyTo: splitAddress(payload.replyTo) } : {}),
    ...(payload.headers ? { headers: payload.headers } : {}),
    ...(payload.attachments?.length
      ? { attachment: payload.attachments.map(a => ({ name: a.filename, content: a.content })) }
      : {}),
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const result = (await response.json().catch(() => ({}))) as { messageId?: string; message?: string; code?: string }
  if (!response.ok) throw new Error(result.message || `Brevo send failed (HTTP ${response.status})`)
  return { id: result.messageId ? String(result.messageId).replace(/^<|>$/g, '') : null }
}

function encodeHeaderWord(value: string): string {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function buildRawMime(payload: SendPayload): string {
  const boundary = `nc_${randomBytes(12).toString('hex')}`
  const sender = payload.fromName ? `${encodeHeaderWord(payload.fromName)} <${payload.from}>` : payload.from
  const lines = [
    `From: ${sender}`,
    `To: ${payload.to.join(', ')}`,
    ...(payload.cc?.length ? [`Cc: ${payload.cc.join(', ')}`] : []),
    ...(payload.replyTo ? [`Reply-To: ${payload.replyTo}`] : []),
    `Subject: ${encodeHeaderWord(payload.subject)}`,
    'MIME-Version: 1.0',
    ...Object.entries(payload.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
  ]

  const text = payload.text ?? ''
  const html = payload.html ?? ''
  if (html && text) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(text, 'utf8').toString('base64'), '',
      `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(html, 'utf8').toString('base64'), '', `--${boundary}--`, '')
  } else {
    lines.push(`Content-Type: text/${html ? 'html' : 'plain'}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '',
      Buffer.from(html || text, 'utf8').toString('base64'), '')
  }
  return lines.join('\r\n')
}

async function sendViaSes(payload: SendPayload): Promise<SendResult> {
  const region = process.env.AWS_SES_REGION ?? 'eu-north-1'
  return { id: await sesSendRaw(buildRawMime(payload), region, { to: payload.to, cc: payload.cc, bcc: payload.bcc }) }
}

/**
 * A mailbox this deployment owns that keeps a copy of everything the app sends on its own
 * behalf. Product mail is invisible otherwise: it leaves for the recipient and no account
 * here ever sees it. Skipped when the archive is already a recipient, so a message never
 * arrives twice.
 */
function withArchive(payload: SendPayload): SendPayload {
  const archive = (process.env.MAIL_ARCHIVE_BCC ?? '').trim().toLowerCase()
  if (!archive || payload.skipArchive) return payload
  const already = [...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])]
    .some(entry => entry.toLowerCase().includes(archive))
  if (already) return payload
  return { ...payload, bcc: [...(payload.bcc ?? []), archive] }
}

export function sendMail(raw: SendPayload): Promise<SendResult> {
  const payload = withArchive(raw)
  switch (activeProvider()) {
    case 'ses': return sendViaSes(payload)
    case 'brevo': return sendViaBrevo(payload)
    default: return sendViaResend(payload)
  }
}

// ── Receiving ───────────────────────────────────────────────────
const asArray = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])

type BrevoAddress = { Address?: string; Name?: string } | string
type BrevoAttachment = { Name?: string; ContentType?: string; ContentLength?: number; DownloadToken?: string }
type BrevoInboundItem = {
  Headers?: Record<string, unknown>
  MessageId?: string
  Uuid?: string | string[]
  From?: BrevoAddress
  To?: BrevoAddress[]
  Cc?: BrevoAddress[]
  Bcc?: BrevoAddress[]
  ReplyTo?: BrevoAddress
  Subject?: string
  RawHtmlBody?: string | null
  HtmlBody?: string | null
  RawTextBody?: string | null
  TextBody?: string | null
  SentAtDate?: string
  Attachments?: BrevoAttachment[]
}

/** Brevo inbound parsing delivers `items[]`; addresses arrive as {Address, Name}. */
export function normalizeBrevoInbound(raw: Record<string, unknown>): NormalizedInbound {
  const item = raw as BrevoInboundItem
  const addr = (entry: BrevoAddress | undefined): string => {
    if (typeof entry === 'string') return entry
    return entry?.Name ? `${entry.Name} <${entry.Address}>` : String(entry?.Address ?? '')
  }
  const list = (value: BrevoAddress[] | undefined): string[] =>
    Array.isArray(value) ? value.map(addr).filter(Boolean) : []
  const headers: Record<string, unknown> = { ...(item.Headers ?? {}) }
  if (item.MessageId && !Object.keys(headers).some(key => key.toLowerCase() === 'message-id')) {
    headers['message-id'] = item.MessageId
  }
  return {
    id: String(item.MessageId ?? item.Uuid?.[0] ?? item.Uuid ?? `in_${Date.now()}`).replace(/^<|>$/g, ''),
    from: addr(item.From),
    to: list(item.To),
    cc: list(item.Cc),
    bcc: list(item.Bcc),
    replyTo: item.ReplyTo ? [addr(item.ReplyTo)] : [],
    subject: String(item.Subject ?? '(no subject)'),
    html: item.RawHtmlBody ?? item.HtmlBody ?? null,
    text: item.RawTextBody ?? item.TextBody ?? null,
    headers,
    receivedAt: item.SentAtDate ? new Date(item.SentAtDate).toISOString() : new Date().toISOString(),
    attachments: Array.isArray(item.Attachments)
      ? item.Attachments.map(attachment => ({
          filename: String(attachment.Name ?? 'attachment'),
          contentType: attachment.ContentType ? String(attachment.ContentType) : undefined,
          size: typeof attachment.ContentLength === 'number' ? attachment.ContentLength : undefined,
          // Brevo exposes a token-based download URL; Phase 0's rule applies — fetch and
          // re-host rather than trusting a provider URL to outlive the message.
          url: attachment.DownloadToken ? `https://api.brevo.com/v3/inbound/attachments/${attachment.DownloadToken}` : undefined,
        }))
      : [],
  }
}

/** True when the payload looks like Brevo inbound parsing rather than a Resend webhook. */
export function isBrevoInbound(body: Record<string, unknown>): boolean {
  return Array.isArray(body?.items) || Boolean(body?.Uuid || body?.RawHtmlBody || body?.SentAtDate)
}

export { asArray }
