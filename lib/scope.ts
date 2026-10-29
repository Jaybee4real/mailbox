import { BRAND, type MailRole } from './brand'

const ALL_INBOXES = (process.env.MAIL_ALL_INBOXES_ADDRESS ?? '')
  .split(',')
  .map(entry => entry.trim().toLowerCase())
  .filter(Boolean)

// The address we send from, and the inbox that owns mail addressed to nobody specific.
export const MAIL_FROM = (process.env.MAIL_FROM ?? process.env.RESEND_FROM ?? BRAND.supportEmail).replace(/^.*<|>$/g, '').trim()
export const SHARED_INBOX = MAIL_FROM.toLowerCase()

export type Viewer = { address: string | null; role: MailRole }

/**
 * Named addresses (MAIL_ALL_INBOXES_ADDRESS, comma-separated) may read every account's mail. Naming them rather
 * than granting it to the admin role keeps the two powers apart: administering accounts
 * still does not carry the right to read someone else's inbox.
 */
export function readsAllInboxes(viewer: Viewer): boolean {
  if (!ALL_INBOXES.length) return false
  if (viewer.role !== 'admin') return false
  return ALL_INBOXES.includes((viewer.address ?? '').toLowerCase())
}

/** The owner to filter reads by, or null for every account. */
export function inboxScope(viewer: Viewer): string | null {
  if (readsAllInboxes(viewer)) return null
  return viewer.address ?? ' no-address'
}

/**
 * Which inbox a request should read. An address the viewer may not see is not an error:
 * it falls back to their own, so a guessed parameter reveals nothing.
 */
export function scopeFor(viewer: Viewer, requested?: string | null): string | null {
  const own = viewer.address ?? ' no-address'
  const wanted = (requested ?? '').trim().toLowerCase()
  const everything = readsAllInboxes(viewer)
  if (!wanted || wanted === 'all') return everything ? null : own
  return everything ? wanted : own
}
