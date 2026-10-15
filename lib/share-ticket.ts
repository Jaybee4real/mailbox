import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * A short-lived permission to fetch one shared file through this domain.
 *
 * The recipient is not a mailbox holder, so there is no session to lean on. The share id
 * is the capability and the password is the second factor, but both are checked once, on
 * the page. This ticket carries that decision the few seconds to the download itself, so
 * the file can be streamed from our own host rather than handing the browser a link to
 * the bucket — a second hostname the recipient's network may not be able to reach.
 */
const TTL_SECONDS = 15 * 60

function secret(): string | null {
  return process.env.MAIL_SESSION_SECRET?.trim() || null
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url')
}

export type TicketMode = 'view' | 'download'

export function issueShareTicket(id: string, mode: TicketMode): string | null {
  const key = secret()
  if (!key) return null
  const payload = `${id}.${mode}.${Date.now() + TTL_SECONDS * 1000}`
  return `${payload}.${sign(payload, key)}`
}

/** The mode of a ticket this server signed, for this share, that has not expired; otherwise null. */
export function shareTicketMode(ticket: string | null, id: string): TicketMode | null {
  const key = secret()
  if (!key || !ticket) return null
  const cut = ticket.lastIndexOf('.')
  if (cut < 1) return null
  const payload = ticket.slice(0, cut)
  const given = ticket.slice(cut + 1)
  const expected = sign(payload, key)
  if (given.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null
  const [signedId, mode, expires] = payload.split('.')
  if (signedId !== id || !(Number(expires) > Date.now())) return null
  return mode === 'view' || mode === 'download' ? mode : null
}

const INLINE_WINDOW_MS = 12 * 60 * 60 * 1000

/**
 * Lets a message's own inline images load inside the reader frame, which is sandboxed to an
 * opaque origin and so never carries the session cookie. The expiry is rounded to a window
 * so the URL stays the same between list refreshes; a new one would reload the frame.
 */
export type InlineScope = 'inbound' | 'sent'

const inlinePayload = (scope: InlineScope, messageId: string, expires: string | number) =>
  `${scope === 'sent' ? 'inline-sent' : 'inline'}:${messageId}:${expires}`

export function inlineImageTicket(messageId: string, now = Date.now(), scope: InlineScope = 'inbound'): string | null {
  const key = secret()
  if (!key) return null
  const expires = (Math.floor(now / INLINE_WINDOW_MS) + 2) * INLINE_WINDOW_MS
  return `${expires}.${sign(inlinePayload(scope, messageId, expires), key)}`
}

export function inlineImageTicketValid(ticket: string | null, messageId: string, now = Date.now(), scope: InlineScope = 'inbound'): boolean {
  const key = secret()
  if (!key || !ticket) return false
  const [expires, given] = ticket.split('.')
  if (!given || !(Number(expires) > now)) return false
  const expected = sign(inlinePayload(scope, messageId, expires), key)
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}
