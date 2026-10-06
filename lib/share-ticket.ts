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
