import type { MailRole } from './brand'

const ALL_INBOXES = (process.env.MAIL_ALL_INBOXES_ADDRESS ?? '').trim().toLowerCase()

export type Viewer = { address: string | null; role: MailRole }

/**
 * One address per deployment may read every account's mail. Naming the address rather
 * than granting it to the admin role keeps the two powers apart: administering accounts
 * still does not carry the right to read someone else's inbox.
 */
export function readsAllInboxes(viewer: Viewer): boolean {
  if (!ALL_INBOXES) return false
  if (viewer.role !== 'admin') return false
  return (viewer.address ?? '').toLowerCase() === ALL_INBOXES
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
