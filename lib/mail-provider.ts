import { BlockedRecipientsError, blockedAmong } from './blocked'
import { readRateLimit, velaApiBase, velaApiKey, velaConfigProblem, type RequesterContext, type RequestPurpose } from './vela'

export type SendAttachment = { filename: string; content: string; contentType?: string; contentId?: string }

export type SendContext = RequesterContext & { purpose: RequestPurpose }

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
  context?: SendContext
}

export type SendResult = { id: string | null; throttled?: boolean; retryAfter?: number }

export const providerConfigProblem = velaConfigProblem

const compactContext = (context: SendContext) =>
  Object.fromEntries(Object.entries(context).filter(([, value]) => typeof value === 'string' && value))

export function velaSendBody(payload: SendPayload): Record<string, unknown> {
  return {
    from: payload.fromName ? `${payload.fromName.replace(/[<>"\r\n]/g, '')} <${payload.from}>` : payload.from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text?.trim() || ' ',
    ...(payload.html ? { html: payload.html } : {}),
    ...(payload.cc?.length ? { cc: payload.cc } : {}),
    ...(payload.bcc?.length ? { bcc: payload.bcc } : {}),
    ...(payload.replyTo ? { reply_to: payload.replyTo } : {}),
    ...(payload.scheduledAt ? { scheduled_at: payload.scheduledAt } : {}),
    ...(payload.headers && Object.keys(payload.headers).length ? { headers: payload.headers } : {}),
    ...(payload.attachments?.length
      ? {
          attachments: payload.attachments.map(file => ({
            filename: file.filename,
            content: file.content.replace(/\s+/g, ''),
            ...(file.contentType ? { content_type: file.contentType } : {}),
            ...(file.contentId ? { content_id: file.contentId.replace(/^<|>$/g, '') } : {}),
          })),
        }
      : {}),
    ...(payload.context ? { context: compactContext(payload.context) } : {}),
  }
}

async function sendViaVela(payload: SendPayload): Promise<SendResult> {
  const apiKey = velaApiKey()
  if (!apiKey) throw new Error('VELA_API_KEY is not configured')
  const response = await fetch(`${velaApiBase()}/emails`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(velaSendBody(payload)),
  })
  const blocked = await readRateLimit(response)
  if (blocked) throw blocked
  const result = (await response.json().catch(() => ({}))) as { id?: unknown; throttled?: unknown; retry_after?: unknown; message?: unknown }
  if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : `Vela send failed (HTTP ${response.status})`)
  if (result.throttled === true) {
    const seconds = Number(result.retry_after)
    return { id: null, throttled: true, retryAfter: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60 }
  }
  return { id: result.id ? String(result.id) : null }
}

/**
 * A mailbox this deployment owns that keeps a copy of everything the app sends on its own
 * behalf. Product mail is invisible otherwise: it leaves for the recipient and no account
 * here ever sees it. Skipped when the archive is already a recipient, so a message never
 * arrives twice, and skipped for anything a person wrote — their Sent folder already has it.
 */
export const archiveAddress = () => (process.env.MAIL_ARCHIVE_BCC ?? '').trim().toLowerCase()

function withArchive(payload: SendPayload): SendPayload {
  const archive = archiveAddress()
  if (!archive || payload.skipArchive) return payload
  const already = [...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])]
    .some(entry => entry.toLowerCase().includes(archive))
  if (already) return payload
  return { ...payload, bcc: [...(payload.bcc ?? []), archive] }
}

export async function sendMail(raw: SendPayload): Promise<SendResult> {
  const blocked = await blockedAmong([...raw.to, ...(raw.cc ?? []), ...(raw.bcc ?? [])])
  if (blocked.length) throw new BlockedRecipientsError(blocked)
  return sendViaVela(withArchive(raw))
}
