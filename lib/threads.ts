export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export const THREAD_GAP_MS = 30 * 24 * 60 * 60 * 1000

export function subjectKey(subject: string): string {
  return normalizeSubject(subject)
}

const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
])

/**
 * Who a message is with, outside our own domains: a company by its domain, a person on a
 * free-mail domain by their address. A title is reused for every insurer a quote goes to, so
 * the title alone does not make two messages one conversation; the title and the party do.
 */
export function threadParties(addresses: string[], ownDomains: string[]): string[] {
  const own = new Set(ownDomains.map(domain => domain.toLowerCase()))
  const parties = new Set<string>()
  for (const raw of addresses) {
    const address = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase()
    const at = address.lastIndexOf('@')
    if (at < 1) continue
    const domain = address.slice(at + 1)
    if (own.has(domain)) continue
    parties.add(PERSONAL_DOMAINS.has(domain) ? address : domain)
  }
  return [...parties]
}

export function sharesParty(left: string[], right: string[]): boolean {
  if (!left.length || !right.length) return !left.length && !right.length
  return left.some(party => right.includes(party))
}

export function subjectSignals(subject: string, parties: string[]): string[] {
  const key = normalizeSubject(subject)
  if (!key) return []
  return parties.length ? parties.map(party => `subj:${key}|${party}`) : [`subj:${key}|internal`]
}

/** Readable and deterministic: the normalised subject plus the day the thread began. */
export function threadIdFor(key: string, firstAt: string, messageId: string): string {
  return key ? `${key}#${firstAt.slice(0, 10)}` : `msg:${messageId}`
}

export type ThreadFlags = { read?: boolean; starred?: boolean; archived?: boolean; trashed?: boolean }

type FlaggedMessage = { id: string; threadId?: string | null } & Required<ThreadFlags>

type ThreadCounts = {
  threadId: string
  unreadCount: number
  starredCount: number
  inboxCount: number
  archivedCount: number
  trashedCount: number
}

const bucketsFor = (row: Required<ThreadFlags>) => ({
  unreadCount: !row.read && !row.trashed ? 1 : 0,
  starredCount: row.starred && !row.trashed ? 1 : 0,
  inboxCount: !row.archived && !row.trashed ? 1 : 0,
  archivedCount: row.archived && !row.trashed ? 1 : 0,
  trashedCount: row.trashed ? 1 : 0,
})

const BUCKETS = ['unreadCount', 'starredCount', 'inboxCount', 'archivedCount', 'trashedCount'] as const

export function applyThreadFlagDeltas<Row extends ThreadCounts>(
  threads: Row[],
  messages: FlaggedMessage[],
  ids: string[],
  flags: ThreadFlags,
): Row[] {
  const changing = new Set(ids)
  const deltas = new Map<string, Record<(typeof BUCKETS)[number], number>>()
  for (const message of messages) {
    if (!message.threadId || !changing.has(message.id)) continue
    const before = bucketsFor(message)
    const after = bucketsFor({ ...message, ...flags })
    for (const bucket of BUCKETS) {
      if (after[bucket] === before[bucket]) continue
      const entry =
        deltas.get(message.threadId) ??
        { unreadCount: 0, starredCount: 0, inboxCount: 0, archivedCount: 0, trashedCount: 0 }
      entry[bucket] += after[bucket] - before[bucket]
      deltas.set(message.threadId, entry)
    }
  }
  if (deltas.size === 0) return threads
  return threads.map(thread => {
    const delta = deltas.get(thread.threadId)
    if (!delta) return thread
    const next = { ...thread }
    for (const bucket of BUCKETS) next[bucket] = Math.max(0, thread[bucket] + delta[bucket])
    return next
  })
}
