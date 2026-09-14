import { ADDRESS_ALIASES, MAIL_SEATS, type MailRole } from './brand'
/**
 * Durable mail state on Cloudflare D1 (SQLite). Inbox, delivery events, account
 * credentials, reset tokens, and a per-account stash for drafts + saved templates.
 *
 * SQLite differences that matter here: booleans are 0/1, JSON columns are TEXT and come
 * back as strings (Postgres jsonb arrived pre-parsed), and timestamps are ISO strings
 * supplied by the app rather than `now()`.
 */

import { d1, d1Batch, d1Query } from './d1'
import { stripCidPlaceholders } from './email-html'
import { hashPassword } from './password'
import { turso, tursoBatch, tursoQuery } from './turso'
import { subjectKey, threadIdFor, THREAD_GAP_MS } from './threads'

export type InboundAttachment = { filename: string; contentType?: string; size?: number; shareId?: string }

export type InboundEmail = {
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
  read: boolean
  attachments: InboundAttachment[]
  starred: boolean
  archived: boolean
  trashed: boolean
  labels: string[]
  owner: string | null
  threadId: string | null
}

export type InboundFlags = Partial<Pick<InboundEmail, 'read' | 'starred' | 'archived' | 'trashed'>>

export type Contact = { email: string; name: string | null }

export type MailEvent = {
  emailId: string
  type: string
  at: string
  meta?: Record<string, string>
}

export type StashItem = {
  id: string
  data: unknown
  updatedAt: string
}

const MAX_INBOX = 500
const MAX_EVENTS = 150

/** Turso once it is configured, D1 until then, so the switch needs no redeploy dance. */
const tursoConfigured = () => Boolean(process.env.TURSO_DATABASE_URL)

function db() {
  return tursoConfigured() ? turso() : d1()
}

/** Raw SQL with positional args, for queries whose shape is built at runtime. */
function tagged(_sql: unknown, text: string, args: unknown[]): Promise<Record<string, unknown>[]> {
  return tursoConfigured() ? tursoQuery(text, args) : d1Query(text, args)
}

function sqlRaw(text: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  return tursoConfigured() ? tursoQuery(text, args) : d1Query(text, args)
}

function dbBatch(statements: string[]): Promise<void> {
  return tursoConfigured() ? tursoBatch(statements) : d1Batch(statements)
}

function nowIso(): string {
  return new Date().toISOString()
}

/** JSON columns are TEXT in SQLite — tolerate already-parsed values and bad data. */
function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value as T
  if (typeof value !== 'string') return fallback
  try {
    const parsed = JSON.parse(value)
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}

function parseArray(value: unknown): string[] {
  const parsed = parseJson<unknown>(value, [])
  return Array.isArray(parsed) ? parsed.map(String) : []
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * Create the schema on first use. D1 has no migration runner either, but unlike the
 * Postgres original we own the full CREATE, so there are no incremental ALTERs to replay.
 * Memoized per server instance.
 */
let schemaReady: Promise<void> | null = null
export function ensureMailSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await dbBatch([
        `CREATE TABLE IF NOT EXISTS mail_inbox (
          id TEXT PRIMARY KEY,
          from_addr TEXT,
          to_addrs TEXT,
          cc TEXT,
          bcc TEXT,
          reply_to TEXT,
          subject TEXT,
          html TEXT,
          body_text TEXT,
          headers TEXT,
          received_at TEXT,
          read INTEGER NOT NULL DEFAULT 0,
          attachments TEXT,
          starred INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          trashed INTEGER NOT NULL DEFAULT 0,
          labels TEXT,
          owner TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS mail_inbox_received_idx ON mail_inbox (received_at DESC)`,
        `CREATE INDEX IF NOT EXISTS mail_inbox_owner_idx ON mail_inbox (lower(owner))`,
        // The list always filters by mailbox and folder and sorts by date. Without an
        // index carrying all three, SQLite reads every matching row into a temp B-tree to
        // sort it and then discards all but one page.
        `CREATE INDEX IF NOT EXISTS mail_inbox_list_idx ON mail_inbox (lower(owner), archived, trashed, received_at DESC, id DESC)`,
        `CREATE INDEX IF NOT EXISTS mail_inbox_owner_recent_idx ON mail_inbox (lower(owner), received_at DESC, id DESC)`,
        `CREATE INDEX IF NOT EXISTS mail_inbox_thread_idx ON mail_inbox (lower(owner), thread_id, received_at DESC, id DESC)`,
        // The folder counts read only these five columns. Without them all in one index
        // SQLite walks the rows themselves, and a row here can carry 50KB of html — which
        // turned a five-number summary into a 37-second scan on the larger mailboxes.
        `CREATE INDEX IF NOT EXISTS mail_inbox_counts_idx ON mail_inbox (lower(owner), archived, trashed, read, starred)`,
        `CREATE TABLE IF NOT EXISTS mail_threads (
          owner TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          subject TEXT,
          first_at TEXT NOT NULL,
          latest_at TEXT NOT NULL,
          latest_id TEXT,
          count INTEGER NOT NULL DEFAULT 0,
          unread_count INTEGER NOT NULL DEFAULT 0,
          starred_count INTEGER NOT NULL DEFAULT 0,
          inbox_count INTEGER NOT NULL DEFAULT 0,
          archived_count INTEGER NOT NULL DEFAULT 0,
          trashed_count INTEGER NOT NULL DEFAULT 0,
          attach_count INTEGER NOT NULL DEFAULT 0,
          senders TEXT,
          snippet TEXT,
          labels TEXT,
          PRIMARY KEY (owner, thread_id)
        )`,
        `CREATE INDEX IF NOT EXISTS mail_threads_latest_idx ON mail_threads (owner, latest_at DESC)`,
        `CREATE INDEX IF NOT EXISTS mail_threads_key_idx ON mail_threads (owner, subject_key, latest_at DESC)`,
        `CREATE INDEX IF NOT EXISTS mail_threads_list_idx ON mail_threads (owner, latest_at DESC, thread_id DESC)`,
        `CREATE INDEX IF NOT EXISTS mail_inbox_folder_idx ON mail_inbox (archived, trashed, received_at DESC, id DESC)`,
        `CREATE INDEX IF NOT EXISTS mail_inbox_starred_idx ON mail_inbox (starred, trashed, received_at DESC, id DESC)`,
        // Finds rows whose body still sits in the database. Partial, so it shrinks to
        // nothing as bodies move to the bucket instead of growing with the mailbox.
        `CREATE INDEX IF NOT EXISTS mail_inbox_html_pending_idx ON mail_inbox (id) WHERE html IS NOT NULL AND html != ''`,
        // password_hash is nullable: invited accounts exist before a password is set.
        `CREATE TABLE IF NOT EXISTS mail_accounts (
          email TEXT PRIMARY KEY,
          password_hash TEXT,
          role TEXT NOT NULL DEFAULT 'member',
          name TEXT,
          address TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT,
          invited_by TEXT
        )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS mail_accounts_address_key ON mail_accounts (lower(address)) WHERE address IS NOT NULL`,
        `CREATE TABLE IF NOT EXISTS mail_sent_flags (
          email_id TEXT PRIMARY KEY,
          starred INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          trashed INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT
        )`,
        // Full copies of what we've sent. The Sent folder used to read live from the
        // provider, which meant the history existed nowhere else — this makes it ours.
        `CREATE TABLE IF NOT EXISTS mail_sent (
          id TEXT PRIMARY KEY,
          from_addr TEXT,
          to_addrs TEXT,
          cc TEXT,
          bcc TEXT,
          reply_to TEXT,
          subject TEXT,
          html TEXT,
          body_text TEXT,
          created_at TEXT,
          last_event TEXT,
          provider TEXT,
          archived_at TEXT,
          attachments TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS mail_sent_created_idx ON mail_sent (created_at DESC)`,
        // Covers the Sent list query. Bodies sit before created_at in the row, so without
        // this SQLite walks every message's overflow pages just to read its date.
        `CREATE INDEX IF NOT EXISTS mail_sent_list_idx ON mail_sent (created_at DESC, id, from_addr, to_addrs, cc, bcc, reply_to, subject, last_event)`,
        `CREATE TABLE IF NOT EXISTS mail_sent_meta (
          email_id TEXT PRIMARY KEY,
          owner TEXT,
          is_auto INTEGER NOT NULL DEFAULT 0,
          created_at TEXT,
          in_reply_to TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS mail_pixels (
          pixel_id TEXT PRIMARY KEY,
          email_id TEXT,
          recipient TEXT,
          subject TEXT,
          open_count INTEGER NOT NULL DEFAULT 0,
          opened_at TEXT,
          created_at TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS mail_pixels_email_idx ON mail_pixels (email_id)`,
        `CREATE TABLE IF NOT EXISTS mail_contacts (
          email TEXT PRIMARY KEY,
          name TEXT,
          seen_count INTEGER NOT NULL DEFAULT 1,
          last_seen TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS mail_push_subscriptions (
          endpoint TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          subscription TEXT NOT NULL,
          created_at TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS mail_push_owner_idx ON mail_push_subscriptions (owner)`,
        `CREATE TABLE IF NOT EXISTS mail_settings (
          owner TEXT PRIMARY KEY,
          data TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS mail_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email_id TEXT,
          type TEXT,
          at TEXT,
          meta TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS mail_events_at_idx ON mail_events (at DESC)`,
        // Large attachments live in object storage; this is the record that lets
        // a recipient claim one, and the only place the password hash is kept.
        `CREATE TABLE IF NOT EXISTS mail_shares (
          id TEXT PRIMARY KEY,
          object_key TEXT NOT NULL,
          filename TEXT NOT NULL,
          content_type TEXT,
          size INTEGER NOT NULL DEFAULT 0,
          password_hash TEXT,
          owner TEXT,
          created_at TEXT,
          expires_at TEXT,
          downloads INTEGER NOT NULL DEFAULT 0,
          max_downloads INTEGER,
          revoked INTEGER NOT NULL DEFAULT 0
        )`,
        `CREATE INDEX IF NOT EXISTS mail_shares_owner_idx ON mail_shares (owner, created_at DESC)`,
        // Folder counts walk the whole mailbox index and Turso meters every entry; an
        // in-memory cache dies with the instance, and instances churn under polling. One
        // row here outlives them all.
        `CREATE TABLE IF NOT EXISTS mail_counts_cache (
          owner TEXT PRIMARY KEY,
          computed_at TEXT NOT NULL,
          counts TEXT NOT NULL
        )`,
        // Full-text search belongs in the database, not the browser. The client used to
        // pull the mailbox down and filter it in JS, which cannot hold once the archive
        // runs to six figures.
        `CREATE VIRTUAL TABLE IF NOT EXISTS mail_inbox_fts USING fts5(
          subject, body_text, from_addr, to_addrs,
          content='mail_inbox', content_rowid='rowid', tokenize='porter unicode61'
        )`,
        `CREATE TRIGGER IF NOT EXISTS mail_inbox_fts_ai AFTER INSERT ON mail_inbox BEGIN
          INSERT INTO mail_inbox_fts(rowid, subject, body_text, from_addr, to_addrs)
          VALUES (new.rowid, new.subject, new.body_text, new.from_addr, new.to_addrs);
        END`,
        `CREATE TRIGGER IF NOT EXISTS mail_inbox_fts_ad AFTER DELETE ON mail_inbox BEGIN
          INSERT INTO mail_inbox_fts(mail_inbox_fts, rowid, subject, body_text, from_addr, to_addrs)
          VALUES ('delete', old.rowid, old.subject, old.body_text, old.from_addr, old.to_addrs);
        END`,
        // Flags change constantly and the indexed text almost never does; re-tokenising
        // a whole body to mark it read was metered work for nothing.
        `CREATE TRIGGER IF NOT EXISTS mail_inbox_fts_au AFTER UPDATE ON mail_inbox
         WHEN old.subject IS NOT new.subject OR old.body_text IS NOT new.body_text
           OR old.from_addr IS NOT new.from_addr OR old.to_addrs IS NOT new.to_addrs
         BEGIN
          INSERT INTO mail_inbox_fts(mail_inbox_fts, rowid, subject, body_text, from_addr, to_addrs)
          VALUES ('delete', old.rowid, old.subject, old.body_text, old.from_addr, old.to_addrs);
          INSERT INTO mail_inbox_fts(rowid, subject, body_text, from_addr, to_addrs)
          VALUES (new.rowid, new.subject, new.body_text, new.from_addr, new.to_addrs);
        END`,
        `CREATE INDEX IF NOT EXISTS mail_inbox_received_idx ON mail_inbox (received_at DESC)`,
        `CREATE TABLE IF NOT EXISTS mail_reset_tokens (
          token TEXT PRIMARY KEY,
          email TEXT,
          expires_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS mail_stash (
          owner TEXT,
          kind TEXT,
          id TEXT,
          data TEXT,
          updated_at TEXT,
          PRIMARY KEY (owner, kind, id)
        )`,
        `CREATE TABLE IF NOT EXISTS mail_webhook_events (
          id TEXT PRIMARY KEY,
          handled_at TEXT,
          status TEXT NOT NULL DEFAULT 'working'
        )`,
        `CREATE INDEX IF NOT EXISTS mail_webhook_events_age_idx ON mail_webhook_events (handled_at)`,
      ])

      // SQLite has no ADD COLUMN IF NOT EXISTS, so this runs on its own and is
      // allowed to fail: the second time round the column is already there.
      await sqlRaw('ALTER TABLE mail_accounts ADD COLUMN password_is_default INTEGER NOT NULL DEFAULT 0')
        .catch(() => {})
      await sqlRaw("ALTER TABLE mail_webhook_events ADD COLUMN status TEXT NOT NULL DEFAULT 'working'")
        .catch(() => {})
      await sqlRaw('ALTER TABLE mail_sent ADD COLUMN attachments TEXT').catch(() => {})

      // Drawing a list row needed the whole message: 24KB of body to show 320 characters
      // of it, 5KB of headers to read three of them, and the attachment list to learn
      // whether there was one. These hold just those answers.
      await sqlRaw('ALTER TABLE mail_inbox ADD COLUMN snippet TEXT').catch(() => {})
      await sqlRaw('ALTER TABLE mail_inbox ADD COLUMN thread_meta TEXT').catch(() => {})
      await sqlRaw('ALTER TABLE mail_inbox ADD COLUMN attach_meta TEXT').catch(() => {})
      // The two indexes on thread_id are built deliberately by maintenance, not here: a
      // build walks the whole table, and attempting it on every cold start under a metered
      // read quota is a bill that never stops coming.
      await sqlRaw('ALTER TABLE mail_inbox ADD COLUMN thread_id TEXT').catch(() => {})

      // Seed the mailboxes this deployment serves — metadata only, never clobber an
      // existing password_hash.
      const sql = db()
      for (const seat of MAIL_SEATS) {
        // Every seat starts with its own address as the password, stored hashed like
        // any other, and flagged so the interface can ask them to change it. An
        // account that already has a password of its own is never overwritten.
        const seeded = await hashPassword(seat.email)
        await sql`
          INSERT INTO mail_accounts (email, role, name, address, status, created_at, password_hash, password_is_default)
          VALUES (${seat.email}, ${seat.role}, ${seat.name}, ${seat.address}, 'active', ${nowIso()}, ${seeded}, 1)
          ON CONFLICT (email) DO UPDATE SET
            status = 'active',
            role = COALESCE(mail_accounts.role, excluded.role),
            name = COALESCE(mail_accounts.name, excluded.name),
            address = COALESCE(mail_accounts.address, excluded.address),
            password_hash = COALESCE(mail_accounts.password_hash, excluded.password_hash),
            password_is_default = CASE
              WHEN mail_accounts.password_hash IS NULL THEN 1
              ELSE mail_accounts.password_is_default END`
      }
    })().catch(err => {
      // Reset so a transient failure can retry on the next call instead of caching a rejection.
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

// ── Inbox ──────────────────────────────────────────────────────
function mapInbound(row: Record<string, unknown>): InboundEmail {
  return {
    id: String(row.id),
    from: (row.from_addr as string) ?? '',
    to: parseArray(row.to_addrs),
    cc: parseArray(row.cc),
    bcc: parseArray(row.bcc),
    replyTo: parseArray(row.reply_to),
    subject: (row.subject as string) ?? '',
    html: (row.html as string) ?? null,
    text: (row.body_text as string) ?? null,
    headers: parseJson<Record<string, unknown>>(row.headers, {}),
    receivedAt: isoOrNull(row.received_at) ?? new Date(0).toISOString(),
    read: Boolean(row.read),
    attachments: parseJson<InboundAttachment[]>(row.attachments, []),
    starred: Boolean(row.starred),
    archived: Boolean(row.archived),
    trashed: Boolean(row.trashed),
    labels: parseArray(row.labels),
    owner: (row.owner as string) ?? null,
    threadId: row.thread_id == null ? null : String(row.thread_id),
  }
}

/**
 * Server-side inbox query. Free text goes to the FTS5 index; the structured operators
 * (is:, has:, label:, in:, from:, to:) become SQL predicates. Returns a page, not the
 * whole mailbox — 140k messages cannot be filtered in the browser.
 */
export type InboxPage = {
  rows: InboundEmail[]
  total: number | null
  nextCursor: string | null
}

/**
 * One page of a mailbox.
 *
 * Two things keep this fast on an archive of this size. The row carries a short snippet
 * rather than its body — the list only ever renders one line of it, and shipping whole
 * bodies cost half a megabyte a page. And paging is by cursor rather than offset, so page
 * fifty costs the same as page one instead of re-reading and discarding everything above it.
 */
export async function searchInbox(options: {
  text?: string
  owner?: string
  folder?: 'inbox' | 'archive' | 'trash' | 'starred'
  unread?: boolean
  starred?: boolean
  hasAttachment?: boolean
  label?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
  cursor?: string | null
  withTotal?: boolean
  threadId?: string
}): Promise<InboxPage> {
  await ensureMailSchema()
  const sql = db()
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const offset = Math.max(options.offset ?? 0, 0)

  const where: string[] = []
  let ftsFrom = ''
  const args: unknown[] = []

  const text = options.text?.trim()
  if (text) {
    // Quote each term so a stray operator character cannot break FTS5 syntax.
    const match = text.split(/\s+/).filter(Boolean).map(term => `"${term.replace(/"/g, '""')}"`).join(' ')
    // Unbounded, every full-text hit went to the outer query, which then walked the whole
    // mailbox checking rows against them; a poll re-running that every tick was most of a
    // month's read quota. Joining the best three thousand by rank makes the match drive the
    // query, so it probes those rows and no others.
    ftsFrom = '(SELECT rowid AS fts_rid FROM mail_inbox_fts WHERE mail_inbox_fts MATCH ? ORDER BY rank LIMIT 3000) fts CROSS JOIN '
    args.push(match)
  }
  if (options.owner) { where.push('lower(m.owner) = ?'); args.push(options.owner.toLowerCase()) }
  if (options.threadId) { where.push('m.thread_id = ?'); args.push(options.threadId) }
  if (options.unread !== undefined) { where.push('m.read = ?'); args.push(options.unread ? 0 : 1) }
  if (options.starred !== undefined) { where.push('m.starred = ?'); args.push(options.starred ? 1 : 0) }
  if (options.hasAttachment) where.push("m.attachments IS NOT NULL AND m.attachments NOT IN ('', '[]')")
  if (options.label) { where.push('m.labels LIKE ?'); args.push(`%${options.label}%`) }
  if (options.from) { where.push('lower(m.from_addr) LIKE ?'); args.push(`%${options.from.toLowerCase()}%`) }
  if (options.to) { where.push('lower(m.to_addrs) LIKE ?'); args.push(`%${options.to.toLowerCase()}%`) }

  if (options.folder === 'trash') where.push('m.trashed = 1')
  else if (options.folder === 'archive') where.push('m.archived = 1 AND m.trashed = 0')
  else if (options.folder === 'starred') where.push('m.starred = 1 AND m.trashed = 0')
  else if (options.folder === 'inbox') where.push('m.archived = 0 AND m.trashed = 0')

  const filterClause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  // The cursor is the last row of the previous page; ordering by (date, id) keeps it
  // stable when several messages share a timestamp.
  const pageWhere = [...where]
  const pageArgs = [...args]
  const cursor = decodeCursor(options.cursor)
  if (cursor) {
    pageWhere.push('(m.received_at, m.id) < (?, ?)')
    pageArgs.push(cursor.receivedAt, cursor.id)
  }
  const pageClause = pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : ''

  const rows = await tagged(
    sql,
    `SELECT m.id, m.from_addr, m.to_addrs, m.cc, m.bcc, m.reply_to, m.subject,
            COALESCE(m.snippet, substr(COALESCE(m.body_text, ''), 1, 320)) AS snippet,
            COALESCE(m.thread_meta, json_object(
              'message-id', COALESCE(json_extract(m.headers, '$."message-id"'), ''),
              'in-reply-to', COALESCE(json_extract(m.headers, '$."in-reply-to"'), ''),
              'references', COALESCE(json_extract(m.headers, '$."references"'), ''))) AS headers,
            m.received_at, m.read,
            COALESCE(m.attach_meta, (
              SELECT json_group_array(json_object(
                'filename', json_extract(value, '$.filename'),
                'contentType', json_extract(value, '$.contentType'),
                'size', json_extract(value, '$.size')))
              FROM json_each(CASE WHEN json_valid(m.attachments) THEN m.attachments ELSE '[]' END)), '[]') AS attachments,
            m.starred, m.archived, m.trashed, m.labels, m.owner, m.thread_id
     FROM ${ftsFrom}mail_inbox m ${ftsFrom ? 'ON m.rowid = fts.fts_rid' : ''} ${pageClause}
     ORDER BY m.received_at DESC, m.id DESC LIMIT ?${cursor ? '' : ' OFFSET ?'}`,
    cursor ? [...pageArgs, limit] : [...pageArgs, limit, offset],
  )

  // Counting scans the whole match, so it runs only for the first page; later pages
  // reuse the figure the client already holds.
  let total: number | null = null
  if (options.withTotal !== false && !cursor && offset === 0) {
    const counted = await tagged(sql, `SELECT COUNT(*) AS n FROM ${ftsFrom}mail_inbox m ${ftsFrom ? 'ON m.rowid = fts.fts_rid' : ''} ${filterClause}`, args)
    total = Number((counted[0]?.n as number) ?? 0)
  }

  const mapped = rows.map(row => ({
    ...mapInbound({ ...row, body_text: stripCidPlaceholders(String(row.snippet ?? '')), html: null }),
  }))
  const last = rows[rows.length - 1]
  const nextCursor =
    rows.length === limit && last
      ? encodeCursor(String(last.received_at ?? ''), String(last.id))
      : null

  return { rows: mapped, total, nextCursor }
}

function encodeCursor(receivedAt: string, id: string): string {
  return Buffer.from(`${receivedAt}|${id}`, 'utf8').toString('base64url')
}

function decodeCursor(value?: string | null): { receivedAt: string; id: string } | null {
  if (!value) return null
  try {
    const [receivedAt, id] = Buffer.from(value, 'base64url').toString('utf8').split('|')
    return receivedAt && id ? { receivedAt, id } : null
  } catch {
    return null
  }
}

export type FolderCounts = {
  inbox: number
  unread: number
  starred: number
  archived: number
  trashed: number
}

/**
 * Folder totals for a whole mailbox.
 *
 * These have to come from the database. Counting the rows the browser happens to hold
 * describes the current page rather than the mailbox, and the figure climbs as you scroll
 * — and because the list groups messages into conversations while unread counts messages,
 * the two were not even in the same units. Every clause here is served by the list indexes.
 */
const COUNTS_CACHE_MS = 5 * 60 * 1000

/** countFolders through a durable cache: one row read when fresh, a full scan only when stale. */
export async function invalidateCounts(owner: string | null | undefined): Promise<void> {
  if (!owner) return
  try {
    await db()`DELETE FROM mail_counts_cache WHERE owner = ${owner.toLowerCase()}`
  } catch {
  }
}

export async function countFoldersCached(owner: string): Promise<FolderCounts> {
  await ensureMailSchema()
  const sql = db()
  const key = owner.toLowerCase()
  const hit = await sql`SELECT computed_at, counts FROM mail_counts_cache WHERE owner = ${key}`
  const row = hit[0]
  if (row && Date.now() - Date.parse(String(row.computed_at)) < COUNTS_CACHE_MS) {
    const parsed = parseJson<FolderCounts | null>(row.counts, null)
    if (parsed) return parsed
  }
  const fresh = await countFolders(owner)
  await sql`
    INSERT INTO mail_counts_cache (owner, computed_at, counts)
    VALUES (${key}, ${new Date().toISOString()}, ${JSON.stringify(fresh)})
    ON CONFLICT (owner) DO UPDATE SET computed_at = excluded.computed_at, counts = excluded.counts`
  return fresh
}

export async function countFolders(owner?: string): Promise<FolderCounts> {
  await ensureMailSchema()
  const sql = db()
  const scope = owner ? 'WHERE lower(owner) = ?' : ''
  const args = owner ? [owner.toLowerCase()] : []

  // One pass, not one per folder: five separate counts read the table five times
  // (206k rows against 69k here) for figures that all come off the same scan.
  const rows = await tagged(
    sql,
    `SELECT
       SUM(CASE WHEN archived = 0 AND trashed = 0 THEN 1 ELSE 0 END) AS inbox,
       SUM(CASE WHEN archived = 0 AND trashed = 0 AND read = 0 THEN 1 ELSE 0 END) AS unread,
       SUM(CASE WHEN starred = 1 AND trashed = 0 THEN 1 ELSE 0 END) AS starred,
       SUM(CASE WHEN archived = 1 AND trashed = 0 THEN 1 ELSE 0 END) AS archived,
       SUM(CASE WHEN trashed = 1 THEN 1 ELSE 0 END) AS trashed
     FROM mail_inbox ${scope}`,
    args,
  )
  const row = rows[0] ?? {}
  const value = (key: string) => Number((row[key] as number) ?? 0)
  return {
    inbox: value('inbox'),
    unread: value('unread'),
    starred: value('starred'),
    archived: value('archived'),
    trashed: value('trashed'),
  }
}

export async function readInbox(filter?: { owner?: string }): Promise<InboundEmail[]> {
  await ensureMailSchema()
  const sql = db()
  const owner = filter?.owner?.trim().toLowerCase()
  const rows = owner
    ? await sql`
        SELECT id, from_addr, to_addrs, cc, bcc, reply_to, subject, html, body_text, headers, received_at, read, attachments, starred, archived, trashed, labels, owner, thread_id
        FROM mail_inbox WHERE lower(owner) = ${owner} ORDER BY received_at DESC LIMIT ${MAX_INBOX}`
    : await sql`
        SELECT id, from_addr, to_addrs, cc, bcc, reply_to, subject, html, body_text, headers, received_at, read, attachments, starred, archived, trashed, labels, owner, thread_id
        FROM mail_inbox ORDER BY received_at DESC LIMIT ${MAX_INBOX}`
  return rows.map(mapInbound)
}


export type ThreadRow = {
  threadId: string
  subject: string
  firstAt: string
  latestAt: string
  latestId: string | null
  count: number
  unreadCount: number
  starredCount: number
  inboxCount: number
  archivedCount: number
  trashedCount: number
  attachCount: number
  senders: string[]
  snippet: string
  labels: string[]
}

/**
 * Pick or create the thread for a message. A thread is the same normalised subject within
 * a thirty-day silence; the lookup is one indexed read on (owner, subject_key).
 */
export async function assignThread(row: { id: string; owner: string; subject: string; receivedAt: string }): Promise<string> {
  const sql = db()
  const owner = row.owner.toLowerCase()
  const key = subjectKey(row.subject ?? '')
  if (!key) return threadIdFor('', row.receivedAt, row.id)
  const at = Date.parse(row.receivedAt)
  const candidates = await sql`
    SELECT thread_id, first_at, latest_at FROM mail_threads
    WHERE owner = ${owner} AND subject_key = ${key}
    ORDER BY latest_at DESC LIMIT 3`
  for (const candidate of candidates) {
    const first = Date.parse(String(candidate.first_at))
    const latest = Date.parse(String(candidate.latest_at))
    // Within the gap after the newest, or (backfill arriving out of order) before the oldest.
    if ((at >= first && at - latest <= THREAD_GAP_MS) || (at < first && first - at <= THREAD_GAP_MS)) {
      return String(candidate.thread_id)
    }
  }
  return threadIdFor(key, row.receivedAt, row.id)
}

/** Recompute one thread's summary from its members. Idempotent, so every write path can call it. */
export async function refreshThread(ownerRaw: string, threadId: string): Promise<void> {
  const sql = db()
  const owner = ownerRaw.toLowerCase()
  const agg = await sql`
    SELECT COUNT(*) AS n,
      SUM(CASE WHEN read = 0 AND trashed = 0 THEN 1 ELSE 0 END) AS unread,
      SUM(CASE WHEN starred = 1 AND trashed = 0 THEN 1 ELSE 0 END) AS starred,
      SUM(CASE WHEN archived = 0 AND trashed = 0 THEN 1 ELSE 0 END) AS inbox,
      SUM(CASE WHEN archived = 1 AND trashed = 0 THEN 1 ELSE 0 END) AS archived,
      SUM(CASE WHEN trashed = 1 THEN 1 ELSE 0 END) AS trashed,
      SUM(CASE WHEN attachments IS NOT NULL AND attachments NOT IN ('', '[]') THEN 1 ELSE 0 END) AS attach,
      MIN(received_at) AS first_at, MAX(received_at) AS latest_at
    FROM mail_inbox WHERE lower(owner) = ${owner} AND thread_id = ${threadId}`
  const total = Number(agg[0]?.n ?? 0)
  if (total === 0) {
    await sql`DELETE FROM mail_threads WHERE owner = ${owner} AND thread_id = ${threadId}`
    return
  }
  const latest = await sql`
    SELECT id, subject, COALESCE(snippet, substr(COALESCE(body_text, ''), 1, 320)) AS snippet
    FROM mail_inbox WHERE lower(owner) = ${owner} AND thread_id = ${threadId}
    ORDER BY received_at DESC, id DESC LIMIT 1`
  const members = await sql`
    SELECT from_addr, labels FROM mail_inbox WHERE lower(owner) = ${owner} AND thread_id = ${threadId}
    ORDER BY received_at ASC`
  const senders: string[] = []
  const labels = new Set<string>()
  for (const member of members) {
    const from = String(member.from_addr ?? '')
    if (from && !senders.includes(from)) senders.push(from)
    for (const label of parseJson<string[]>(member.labels, [])) labels.add(label)
  }
  const head = latest[0]
  await sql`
    INSERT INTO mail_threads (owner, thread_id, subject_key, subject, first_at, latest_at, latest_id, count,
      unread_count, starred_count, inbox_count, archived_count, trashed_count, attach_count, senders, snippet, labels)
    VALUES (${owner}, ${threadId}, ${subjectKey(String(head?.subject ?? ''))}, ${head?.subject ?? null},
      ${String(agg[0].first_at)}, ${String(agg[0].latest_at)}, ${head?.id ?? null}, ${total},
      ${Number(agg[0].unread ?? 0)}, ${Number(agg[0].starred ?? 0)}, ${Number(agg[0].inbox ?? 0)},
      ${Number(agg[0].archived ?? 0)}, ${Number(agg[0].trashed ?? 0)}, ${Number(agg[0].attach ?? 0)},
      ${JSON.stringify(senders)}, ${String(head?.snippet ?? '')}, ${JSON.stringify([...labels])})
    ON CONFLICT (owner, thread_id) DO UPDATE SET
      subject_key = excluded.subject_key, subject = excluded.subject, first_at = excluded.first_at,
      latest_at = excluded.latest_at, latest_id = excluded.latest_id, count = excluded.count,
      unread_count = excluded.unread_count, starred_count = excluded.starred_count,
      inbox_count = excluded.inbox_count, archived_count = excluded.archived_count,
      trashed_count = excluded.trashed_count, attach_count = excluded.attach_count,
      senders = excluded.senders, snippet = excluded.snippet, labels = excluded.labels`
}

/** Thread the message and refresh its summary; never lets a threading fault fail a write. */
// Live threading stays off until the thread index exists and history is backfilled; on
// before that, every inbound message would walk its whole mailbox to summarise one row.
export const threadsLive = () => process.env.THREADS_LIVE === '1'

async function threadMessage(row: { id: string; owner: string | null; subject: string; receivedAt: string }): Promise<void> {
  if (!threadsLive() || !row.owner) return
  try {
    const threadId = await assignThread({ id: row.id, owner: row.owner, subject: row.subject, receivedAt: row.receivedAt })
    const sql = db()
    await sql`UPDATE mail_inbox SET thread_id = ${threadId} WHERE id = ${row.id}`
    await refreshThread(row.owner, threadId)
  } catch (err) {
    console.error('[threads] could not thread', row.id, err instanceof Error ? err.message : err)
  }
}

/** After a flag or owner change: refresh the row's thread (and the one it left, if any). */
async function rethreadAfterChange(id: string, previousOwner?: string | null, previousThread?: string | null): Promise<void> {
  if (!threadsLive()) return
  try {
    const sql = db()
    const rows = await sql`SELECT owner, thread_id, subject, received_at FROM mail_inbox WHERE id = ${id}`
    const row = rows[0]
    if (previousOwner && previousThread) await refreshThread(previousOwner, previousThread)
    if (!row?.owner) return
    if (!row.thread_id || (previousOwner && String(row.owner).toLowerCase() !== previousOwner.toLowerCase())) {
      await threadMessage({ id, owner: String(row.owner), subject: String(row.subject ?? ''), receivedAt: String(row.received_at) })
      return
    }
    await refreshThread(String(row.owner), String(row.thread_id))
  } catch (err) {
    console.error('[threads] could not refresh', id, err instanceof Error ? err.message : err)
  }
}

export type ThreadFolder = 'inbox' | 'archive' | 'trash' | 'starred'

/** The newest conversations in a folder: one row each, already summarised. */
export type ThreadPage = { rows: ThreadRow[]; nextCursor: string | null }

export async function listThreads(ownerRaw: string, folder: ThreadFolder, limit: number, cursorRaw?: string | null): Promise<ThreadPage> {
  await ensureMailSchema()
  const owner = ownerRaw.toLowerCase()
  const predicate =
    folder === 'archive' ? 'archived_count > 0'
    : folder === 'trash' ? 'trashed_count > 0'
    : folder === 'starred' ? 'starred_count > 0'
    : 'inbox_count > 0'
  const cursor = decodeCursor(cursorRaw)
  const rows = await tagged(db(), `
    SELECT thread_id, subject, first_at, latest_at, latest_id, count, unread_count, starred_count,
      inbox_count, archived_count, trashed_count, attach_count, senders, snippet, labels
    FROM mail_threads WHERE owner = ? AND ${predicate}
      ${cursor ? 'AND (latest_at < ? OR (latest_at = ? AND thread_id < ?))' : ''}
    ORDER BY latest_at DESC, thread_id DESC LIMIT ?`,
    cursor ? [owner, cursor.receivedAt, cursor.receivedAt, cursor.id, limit] : [owner, limit])
  const last = rows[rows.length - 1]
  const nextCursor = rows.length === limit && last ? encodeCursor(String(last.latest_at), String(last.thread_id)) : null
  const mapped = rows.map(row => ({
    threadId: String(row.thread_id),
    subject: String(row.subject ?? ''),
    firstAt: String(row.first_at),
    latestAt: String(row.latest_at),
    latestId: row.latest_id == null ? null : String(row.latest_id),
    count: Number(row.count ?? 0),
    unreadCount: Number(row.unread_count ?? 0),
    starredCount: Number(row.starred_count ?? 0),
    inboxCount: Number(row.inbox_count ?? 0),
    archivedCount: Number(row.archived_count ?? 0),
    trashedCount: Number(row.trashed_count ?? 0),
    attachCount: Number(row.attach_count ?? 0),
    senders: parseJson<string[]>(row.senders, []),
    snippet: String(row.snippet ?? ''),
    labels: parseJson<string[]>(row.labels, []),
  }))
  return { rows: mapped, nextCursor }
}

/**
 * Backfill, phase one: give every message a thread id, oldest first so the thirty-day
 * rule holds for history. Summaries are left for the second phase, so each thread is
 * recomputed once rather than once per member.
 */
export async function assignThreads(limit: number): Promise<{ assigned: number; remaining: number | null }> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    SELECT id, owner, subject, received_at FROM mail_inbox
    WHERE thread_id IS NULL ORDER BY received_at ASC LIMIT ${limit}`
  if (rows.length === 0) return { assigned: 0, remaining: 0 }
  for (const row of rows) {
    const id = String(row.id)
    const receivedAt = String(row.received_at)
    if (!row.owner) {
      await sql`UPDATE mail_inbox SET thread_id = ${threadIdFor('', receivedAt, id)} WHERE id = ${id}`
      continue
    }
    const threadId = await assignThread({ id, owner: String(row.owner), subject: String(row.subject ?? ''), receivedAt })
    await sql`UPDATE mail_inbox SET thread_id = ${threadId} WHERE id = ${id}`
    // The thirty-day lookup reads mail_threads, so the thread has to exist before its next
    // member arrives; a minimal row is enough until phase two fills it in.
    const owner = String(row.owner).toLowerCase()
    await sql`
      INSERT INTO mail_threads (owner, thread_id, subject_key, first_at, latest_at)
      VALUES (${owner}, ${threadId}, ${subjectKey(String(row.subject ?? ''))}, ${receivedAt}, ${receivedAt})
      ON CONFLICT (owner, thread_id) DO UPDATE SET
        first_at = MIN(mail_threads.first_at, excluded.first_at),
        latest_at = MAX(mail_threads.latest_at, excluded.latest_at)`
  }
  return { assigned: rows.length, remaining: null }
}

/**
 * Backfill, phase two: recompute each thread's summary once, walking (owner, thread_id)
 * in order from a cursor so the index is read a single time overall.
 */
export async function refreshThreadsFrom(
  after: { owner: string; threadId: string } | null,
  limit: number,
): Promise<{ refreshed: number; cursor: { owner: string; threadId: string } | null }> {
  await ensureMailSchema()
  const sql = db()
  const pairs = after
    ? await sql`
        SELECT DISTINCT lower(owner) AS owner, thread_id FROM mail_inbox
        WHERE thread_id IS NOT NULL AND owner IS NOT NULL
          AND (lower(owner) > ${after.owner} OR (lower(owner) = ${after.owner} AND thread_id > ${after.threadId}))
        ORDER BY 1, 2 LIMIT ${limit}`
    : await sql`
        SELECT DISTINCT lower(owner) AS owner, thread_id FROM mail_inbox
        WHERE thread_id IS NOT NULL AND owner IS NOT NULL
        ORDER BY 1, 2 LIMIT ${limit}`
  for (const pair of pairs) await refreshThread(String(pair.owner), String(pair.thread_id))
  const last = pairs[pairs.length - 1]
  return { refreshed: pairs.length, cursor: last ? { owner: String(last.owner), threadId: String(last.thread_id) } : null }
}

export async function appendInbound(
  email: Omit<InboundEmail, 'starred' | 'archived' | 'trashed' | 'labels' | 'threadId'>,
): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`
    INSERT INTO mail_inbox (id, from_addr, to_addrs, cc, bcc, reply_to, subject, html, body_text, headers, received_at, read, attachments, owner, snippet, thread_meta, attach_meta)
    VALUES (${email.id}, ${email.from}, ${JSON.stringify(email.to)}, ${JSON.stringify(email.cc)}, ${JSON.stringify(email.bcc)}, ${JSON.stringify(email.replyTo)}, ${email.subject}, ${email.html}, ${email.text}, ${JSON.stringify(email.headers)}, ${email.receivedAt}, ${email.read}, ${JSON.stringify(email.attachments)}, ${email.owner ?? null}, ${listSnippet(email.text)}, ${threadMeta(email.headers)}, ${attachMeta(email.attachments)})
    ON CONFLICT (id) DO NOTHING`
  await threadMessage({ id: email.id, owner: email.owner ?? null, subject: email.subject, receivedAt: email.receivedAt })
  await invalidateCounts(email.owner)
}

export async function getInboundSource(
  id: string,
): Promise<{ owner: string | null; attachments: Array<Record<string, unknown>> } | null> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT owner, attachments FROM mail_inbox WHERE id = ${id}`
  if (!rows[0]) return null
  const parsed = parseJson<unknown>(rows[0].attachments, [])
  return {
    owner: rows[0].owner == null ? null : String(rows[0].owner),
    attachments: Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [],
  }
}

/**
 * A message body lives in one of three places: the row itself, the primary row a shared
 * copy points at, or the bucket. Imported archives keep HTML in the bucket so the database
 * holds only text and metadata; the plain-text body always stays in the row for search.
 */
/**
 * Move message HTML out of the database and into the bucket, in batches.
 *
 * Runs server-side so the bodies travel Turso -> Vercel -> R2 inside the datacenter and
 * never cross the mailbox owner's connection. A shared copy needs no upload at all: its
 * body is byte-identical to the primary's, so it simply drops its duplicate and reads
 * through. body_text stays in the row, which is what the search index is built from.
 */
/**
 * Fills the list columns from the message itself, entirely inside the database — the rows
 * never cross the network. COALESCE in the list query means a row that has not been
 * reached yet still reads correctly from the original columns.
 */
const listSnippet = (text: string | null | undefined) => (text ?? '').slice(0, 320)

const headerString = (headers: Record<string, unknown> | undefined, key: string): string => {
  if (!headers) return ''
  const found = Object.keys(headers).find(name => name.toLowerCase() === key)
  return found ? String(headers[found] ?? '') : ''
}

const threadMeta = (headers: Record<string, unknown> | undefined) =>
  JSON.stringify({
    'message-id': headerString(headers, 'message-id'),
    'in-reply-to': headerString(headers, 'in-reply-to'),
    references: headerString(headers, 'references'),
  })

const attachMeta = (attachments: Array<Record<string, unknown>> | undefined) =>
  JSON.stringify(
    (attachments ?? []).map(entry => ({
      filename: entry.filename,
      contentType: entry.contentType,
      size: entry.size,
    })),
  )

export async function backfillListColumns(limit: number): Promise<{ filled: number; remaining: number | null }> {
  await ensureMailSchema()
  const sql = db()
  // Newest first: those are the rows every mailbox opens on, so the first few thousand
  // buy nearly all of the benefit long before the whole archive is done.
  const rows = await sql`
    SELECT id FROM mail_inbox WHERE snippet IS NULL
    ORDER BY received_at DESC LIMIT ${limit}`
  if (rows.length === 0) return { filled: 0, remaining: 0 }

  const ids = rows.map(row => String(row.id)).filter(id => /^[A-Za-z0-9._:+@-]{1,200}$/.test(id))
  if (ids.length === 0) return { filled: 0, remaining: null }
  const list = ids.map(id => `'${id}'`).join(',')

  await dbBatch([
    `UPDATE mail_inbox SET
       snippet = substr(COALESCE(body_text, ''), 1, 320),
       thread_meta = json_object(
         'message-id', COALESCE(json_extract(headers, '$."message-id"'), ''),
         'in-reply-to', COALESCE(json_extract(headers, '$."in-reply-to"'), ''),
         'references', COALESCE(json_extract(headers, '$."references"'), '')),
       attach_meta = COALESCE(
         (SELECT json_group_array(json_object('filename', json_extract(value, '$.filename'),
                                              'contentType', json_extract(value, '$.contentType'),
                                              'size', json_extract(value, '$.size')))
          FROM json_each(CASE WHEN json_valid(attachments) THEN attachments ELSE '[]' END)),
         '[]')
     WHERE id IN (${list})`,
  ])
  return { filled: ids.length, remaining: null }
}

export async function migrateBodiesToBucket(limit: number, countRemaining = false): Promise<{
  moved: number
  deduped: number
  failed: number
  bytes: number
  remaining: number | null
}> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    SELECT id, html, headers FROM mail_inbox
    WHERE html IS NOT NULL AND html != '' LIMIT ${limit}`

  const result: { moved: number; deduped: number; failed: number; bytes: number; remaining: number | null } = {
    moved: 0, deduped: 0, failed: 0, bytes: 0, remaining: null,
  }
  if (rows.length === 0) return result

  const { presign } = await import('./r2')
  const statements: string[] = []

  // Ids are generated by us, but this is string-interpolated SQL: anything unexpected
  // is left alone rather than concatenated in.
  const safeId = (value: string) => /^[A-Za-z0-9._:+@-]{1,200}$/.test(value)

  const uploads = rows.map(async row => {
    const id = String(row.id)
    const html = String(row.html ?? '')
    if (!safeId(id)) return
    const headers = parseJson<Record<string, unknown>>(row.headers, {})

    if (typeof headers['shared-copy-of'] === 'string' && headers['shared-copy-of']) {
      statements.push(`UPDATE mail_inbox SET html = NULL WHERE id = '${id}'`)
      result.deduped += 1
      result.bytes += html.length
      return
    }

    const key = `bodies/${id}.html`
    try {
      const response = await fetch(presign(key, 'PUT', 300), {
        method: 'PUT',
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: html,
      })
      if (!response.ok) {
        result.failed += 1
        return
      }
    } catch {
      result.failed += 1
      return
    }

    // Cleared only once the bucket has the bytes, and json_set keeps the other headers.
    statements.push(
      `UPDATE mail_inbox SET html = NULL, headers = json_set(COALESCE(headers, '{}'), '$."html-key"', '${key}') WHERE id = '${id}'`,
    )
    result.moved += 1
    result.bytes += html.length
  })

  await Promise.all(uploads)
  if (statements.length) await dbBatch(statements)

  // Counting what is left scans every remaining body and costs far more than moving the
  // batch does, so it is asked for explicitly rather than charged to every call.
  if (countRemaining) {
    const left = await sql`SELECT COUNT(*) AS n FROM mail_inbox WHERE html IS NOT NULL AND html != ''`
    result.remaining = Number(left[0]?.n ?? 0)
  }
  return result
}

/** Full body for one message: the list only carries a snippet, so the reader fetches this. */
async function htmlFromBucket(key: unknown): Promise<string | null> {
  if (typeof key !== 'string' || !key) return null
  const { presign } = await import('./r2')
  const response = await fetch(presign(key, 'GET', 300))
  if (!response.ok) return null
  return response.text()
}

/**
 * Opening a message used to cost three sequential round trips — one for the text, another
 * for the same row's html, a third to follow a shared copy to its primary — before the
 * bucket was even touched. The join resolves the copy in the one query, which matters
 * because most imported mail is a shared copy and the database is a continent away.
 */
export async function resolveInboundBody(id: string): Promise<{ html: string | null; text: string | null }> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    SELECT m.body_text AS body_text, m.html AS html, m.headers AS headers,
           p.html AS primary_html, p.headers AS primary_headers
    FROM mail_inbox m
    LEFT JOIN mail_inbox p ON p.id = json_extract(m.headers, '$."shared-copy-of"')
    WHERE m.id = ${id}`
  const row = rows[0]
  if (!row) return { html: null, text: null }

  const text = row.body_text == null ? null : stripCidPlaceholders(String(row.body_text))
  const own = typeof row.html === 'string' && row.html ? row.html : null
  const shared = typeof row.primary_html === 'string' && row.primary_html ? row.primary_html : null
  if (own || shared) return { html: own ?? shared, text }

  const headers = parseJson<Record<string, unknown>>(row.headers, {})
  const primaryHeaders = parseJson<Record<string, unknown>>(row.primary_headers, {})
  const html = (await htmlFromBucket(headers['html-key'])) ?? (await htmlFromBucket(primaryHeaders['html-key']))
  return { html, text }
}

export async function resolveInboundHtml(id: string): Promise<string | null> {
  return (await resolveInboundBody(id)).html
}

export async function getInboundAttachments(id: string): Promise<Array<Record<string, unknown>>> {
  return (await getInboundSource(id))?.attachments ?? []
}

export type InboundAttachmentRow = {
  id: string
  subject: string
  from: string
  receivedAt: string
  attachments: Array<Record<string, unknown>>
}

/** Every message that holds a stored attachment copy, newest first. */
export async function listInboundWithAttachments(owner: string | null): Promise<InboundAttachmentRow[]> {
  await ensureMailSchema()
  const sql = db()
  const rows = owner
    ? await sql`
        SELECT id, subject, from_addr, received_at, attachments FROM mail_inbox
        WHERE lower(owner) = ${owner.toLowerCase()} AND attachments LIKE '%"url"%' AND trashed = 0
        ORDER BY received_at DESC LIMIT 500`
    : await sql`
        SELECT id, subject, from_addr, received_at, attachments FROM mail_inbox
        WHERE attachments LIKE '%"url"%' AND trashed = 0
        ORDER BY received_at DESC LIMIT 500`
  return rows.map(row => {
    const parsed = parseJson<unknown>(row.attachments, [])
    return {
      id: String(row.id),
      subject: String(row.subject ?? ''),
      from: String(row.from_addr ?? ''),
      receivedAt: String(row.received_at ?? ''),
      attachments: Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [],
    }
  })
}

export async function setInboxOwner(id: string, owner: string | null): Promise<void> {
  const sql = db()
  const before = await sql`SELECT owner, thread_id FROM mail_inbox WHERE id = ${id}`
  await sql`UPDATE mail_inbox SET owner = ${owner ? owner.toLowerCase() : null}, thread_id = NULL WHERE id = ${id}`
  await rethreadAfterChange(id, before[0]?.owner == null ? null : String(before[0].owner), before[0]?.thread_id == null ? null : String(before[0].thread_id))
}

export async function markInboundRead(id: string): Promise<void> {
  const sql = db()
  await sql`UPDATE mail_inbox SET read = 1 WHERE id = ${id}`
  await rethreadAfterChange(id)
}

export async function setInboundFlags(id: string, flags: InboundFlags): Promise<void> {
  const sql = db()
  if (flags.read !== undefined) await sql`UPDATE mail_inbox SET read = ${flags.read} WHERE id = ${id}`
  if (flags.starred !== undefined) await sql`UPDATE mail_inbox SET starred = ${flags.starred} WHERE id = ${id}`
  if (flags.archived !== undefined) await sql`UPDATE mail_inbox SET archived = ${flags.archived} WHERE id = ${id}`
  if (flags.trashed !== undefined) await sql`UPDATE mail_inbox SET trashed = ${flags.trashed} WHERE id = ${id}`
  const owned = await sql`SELECT owner FROM mail_inbox WHERE id = ${id}`
  await invalidateCounts(owned[0]?.owner == null ? null : String(owned[0].owner))
  await rethreadAfterChange(id)
}

export async function setInboundLabels(id: string, labels: string[]): Promise<void> {
  const sql = db()
  await sql`UPDATE mail_inbox SET labels = ${JSON.stringify(labels)} WHERE id = ${id}`
}

// ── Sent-mail flags (star / archive / trash on Resend-sent emails) ──
export type SentFlags = { starred?: boolean; archived?: boolean; trashed?: boolean }

export async function readSentFlags(): Promise<Record<string, Required<SentFlags>>> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT email_id, starred, archived, trashed FROM mail_sent_flags`
  const out: Record<string, Required<SentFlags>> = {}
  for (const row of rows) {
    out[String(row.email_id)] = {
      starred: Boolean(row.starred),
      archived: Boolean(row.archived),
      trashed: Boolean(row.trashed),
    }
  }
  return out
}

export async function setSentFlags(id: string, flags: SentFlags): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`
    INSERT INTO mail_sent_flags (email_id, starred, archived, trashed, updated_at)
    VALUES (${id}, ${flags.starred ?? false}, ${flags.archived ?? false}, ${flags.trashed ?? false}, ${nowIso()})
    ON CONFLICT (email_id) DO UPDATE SET
      starred = COALESCE(${flags.starred ?? null}, mail_sent_flags.starred),
      archived = COALESCE(${flags.archived ?? null}, mail_sent_flags.archived),
      trashed = COALESCE(${flags.trashed ?? null}, mail_sent_flags.trashed),
      updated_at = ${nowIso()}`
}

// ── Open-tracking pixels ───────────────────────────────────────
export type PixelOpen = { opened: boolean; openCount: number; openedAt: string | null }

export async function recordPixel(pixelId: string, emailId: string, recipient: string, subject: string): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`
    INSERT INTO mail_pixels (pixel_id, email_id, recipient, subject, created_at)
    VALUES (${pixelId}, ${emailId}, ${recipient}, ${subject}, ${nowIso()})
    ON CONFLICT (pixel_id) DO NOTHING`
}

export async function markPixelOpened(pixelId: string): Promise<void> {
  const sql = db()
  await sql`
    UPDATE mail_pixels
    SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ${nowIso()})
    WHERE pixel_id = ${pixelId}`
}

export async function readPixelOpens(): Promise<Record<string, PixelOpen>> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    SELECT email_id, SUM(open_count) AS opens, MIN(opened_at) AS first_open
    FROM mail_pixels WHERE email_id IS NOT NULL GROUP BY email_id`
  const out: Record<string, PixelOpen> = {}
  for (const row of rows) {
    const opens = Number(row.opens ?? 0)
    out[String(row.email_id)] = {
      opened: opens > 0,
      openCount: opens,
      openedAt: isoOrNull(row.first_open),
    }
  }
  return out
}

// ── Contacts (recipient autocomplete) ──────────────────────────
export async function recordContact(rawEmail: string, name: string | null): Promise<void> {
  // Callers pass raw header values, which may be "Display Name <addr@host>" — store only
  // the address, or the autocomplete fills up with unusable entries.
  const angle = rawEmail.match(/<([^>]+)>/)
  const email = (angle ? angle[1] : rawEmail).trim().toLowerCase()
  const display = name ?? (angle ? rawEmail.slice(0, rawEmail.indexOf('<')).replace(/["']/g, '').trim() || null : null)
  if (!email || !email.includes('@') || /\s/.test(email)) return
  await ensureMailSchema()
  const sql = db()
  await sql`
    INSERT INTO mail_contacts (email, name, seen_count, last_seen)
    VALUES (${email}, ${display}, 1, ${nowIso()})
    ON CONFLICT (email) DO UPDATE SET
      seen_count = mail_contacts.seen_count + 1,
      last_seen = ${nowIso()},
      name = COALESCE(excluded.name, mail_contacts.name)`
}

export async function searchContacts(query: string): Promise<Contact[]> {
  await ensureMailSchema()
  const sql = db()
  const term = `%${query.trim().toLowerCase()}%`
  const rows = query.trim()
    ? await sql`SELECT email, name FROM mail_contacts WHERE lower(email) LIKE ${term} OR lower(coalesce(name,'')) LIKE ${term} ORDER BY seen_count DESC, last_seen DESC LIMIT 8`
    : await sql`SELECT email, name FROM mail_contacts ORDER BY seen_count DESC, last_seen DESC LIMIT 8`
  return rows.map(row => ({ email: String(row.email), name: (row.name as string) ?? null }))
}

// ── Settings ───────────────────────────────────────────────────
export async function getSettings(owner: string): Promise<Record<string, unknown>> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT data FROM mail_settings WHERE owner = ${owner.toLowerCase()}`
  return parseJson<Record<string, unknown>>(rows[0]?.data, {})
}

export async function setSettings(owner: string, data: Record<string, unknown>): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`
    INSERT INTO mail_settings (owner, data) VALUES (${owner.toLowerCase()}, ${JSON.stringify(data)})
    ON CONFLICT (owner) DO UPDATE SET data = excluded.data`
}

// ── Web Push ───────────────────────────────────────────────────
export type PushSubscriptionRow = { endpoint: string; keys: { p256dh: string; auth: string } }

export async function savePushSubscription(owner: string, subscription: PushSubscriptionRow): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`
    INSERT INTO mail_push_subscriptions (endpoint, owner, subscription, created_at)
    VALUES (${subscription.endpoint}, ${owner.toLowerCase()}, ${JSON.stringify(subscription)}, ${nowIso()})
    ON CONFLICT (endpoint) DO UPDATE SET owner = excluded.owner, subscription = excluded.subscription`
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await ensureMailSchema()
  await db()`DELETE FROM mail_push_subscriptions WHERE endpoint = ${endpoint}`
}

export async function listPushSubscriptions(owner: string): Promise<PushSubscriptionRow[]> {
  await ensureMailSchema()
  const rows = await db()`SELECT subscription FROM mail_push_subscriptions WHERE owner = ${owner.toLowerCase()}`
  return rows.map(row => parseJson<PushSubscriptionRow | null>(row.subscription, null)).filter((row): row is PushSubscriptionRow => Boolean(row?.endpoint))
}

// ── Events ─────────────────────────────────────────────────────
export async function readEvents(): Promise<MailEvent[]> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT email_id, type, at, meta FROM mail_events ORDER BY at DESC LIMIT ${MAX_EVENTS}`
  return rows.map(row => {
    const meta = parseJson<Record<string, string> | null>(row.meta, null)
    return {
      emailId: String(row.email_id ?? ''),
      type: String(row.type ?? ''),
      at: isoOrNull(row.at) ?? new Date(0).toISOString(),
      meta: meta ?? undefined,
    }
  })
}

export async function appendEvent(event: MailEvent): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`
    INSERT INTO mail_events (email_id, type, at, meta)
    VALUES (${event.emailId}, ${event.type}, ${event.at}, ${event.meta ? JSON.stringify(event.meta) : null})`
}

// ── Accounts, roles & password reset ───────────────────────────
export type { MailRole }
/**
 * The mailboxes this deployment serves. `email` is the sign-in identity and `address` is
 * the mailbox it owns; for most tenants they are the same, so a person signs in as the
 * address they are known by. info@ owns the shared inbox, which makes it the admin.
 */
/**
 * Delivery aliases. The aliased seat still exists and can sign in; only mail addressed to
 * it is stored under the target's box, because that is who reads it now.
 */
export { ADDRESS_ALIASES, MAIL_SEATS }

export type MailAccount = {
  email: string
  name: string | null
  address: string | null
  role: MailRole
  status: string
  hasPassword: boolean
  createdAt: string | null
  invitedBy: string | null
}

function mapAccount(row: Record<string, unknown>): MailAccount {
  return {
    email: String(row.email),
    name: (row.name as string) ?? null,
    address: (row.address as string) ?? null,
    role: row.role === 'admin' ? 'admin' : 'member',
    status: (row.status as string) ?? 'active',
    hasPassword: Boolean(row.has_password),
    createdAt: isoOrNull(row.created_at),
    invitedBy: (row.invited_by as string) ?? null,
  }
}

export async function listAccounts(): Promise<MailAccount[]> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT email, name, address, role, status, invited_by, created_at, (password_hash IS NOT NULL) AS has_password FROM mail_accounts ORDER BY created_at ASC`
  return rows.map(mapAccount)
}

export async function getAccount(email: string): Promise<MailAccount | null> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT email, name, address, role, status, invited_by, created_at, (password_hash IS NOT NULL) AS has_password FROM mail_accounts WHERE email = ${email.trim().toLowerCase()}`
  return rows[0] ? mapAccount(rows[0]) : null
}

export async function getAccountByAddress(address: string): Promise<MailAccount | null> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT email, name, address, role, status, invited_by, created_at, (password_hash IS NOT NULL) AS has_password FROM mail_accounts WHERE lower(address) = ${address.trim().toLowerCase()}`
  return rows[0] ? mapAccount(rows[0]) : null
}

export async function createAccount(input: {
  email: string
  address: string
  role?: MailRole
  name?: string | null
  status?: string
  invitedBy?: string | null
}): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`
    INSERT INTO mail_accounts (email, name, address, role, status, invited_by, created_at)
    VALUES (${input.email.trim().toLowerCase()}, ${input.name ?? null}, ${input.address.trim().toLowerCase()}, ${input.role ?? 'member'}, ${input.status ?? 'pending'}, ${input.invitedBy ?? null}, ${nowIso()})
    ON CONFLICT (email) DO UPDATE SET
      name = excluded.name, address = excluded.address, role = excluded.role, invited_by = excluded.invited_by`
}

export async function updateAccount(email: string, patch: { name?: string | null; role?: MailRole; address?: string; status?: string }): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  if (patch.name !== undefined) await sql`UPDATE mail_accounts SET name = ${patch.name} WHERE email = ${email.toLowerCase()}`
  if (patch.role !== undefined) await sql`UPDATE mail_accounts SET role = ${patch.role} WHERE email = ${email.toLowerCase()}`
  if (patch.address !== undefined) await sql`UPDATE mail_accounts SET address = ${patch.address.trim().toLowerCase()} WHERE email = ${email.toLowerCase()}`
  if (patch.status !== undefined) await sql`UPDATE mail_accounts SET status = ${patch.status} WHERE email = ${email.toLowerCase()}`
}

export async function deleteAccount(email: string): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`DELETE FROM mail_accounts WHERE email = ${email.trim().toLowerCase()}`
}

// ── Sent-mail archive (our own copy, independent of any provider) ─
export type SentMessage = {
  id: string
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo: string[]
  subject: string
  html: string | null
  text: string | null
  createdAt: string
  lastEvent?: string | null
  /** The bucket keys that went out with it, so a forward has something of ours to copy. */
  attachments?: Array<{ filename: string; size?: number; contentType?: string; key?: string }>
}

export async function recordSentMessage(message: SentMessage): Promise<void> {
  if (!message.id) return
  await ensureMailSchema()
  const sql = db()
  await sql`
    INSERT INTO mail_sent (id, from_addr, to_addrs, cc, bcc, reply_to, subject, html, body_text, created_at, last_event, provider, archived_at, attachments)
    VALUES (${message.id}, ${message.from}, ${JSON.stringify(message.to)}, ${JSON.stringify(message.cc)}, ${JSON.stringify(message.bcc)}, ${JSON.stringify(message.replyTo)}, ${message.subject}, ${message.html}, ${message.text}, ${message.createdAt}, ${message.lastEvent ?? null}, ${process.env.MAIL_PROVIDER ?? 'resend'}, ${nowIso()}, ${JSON.stringify(message.attachments ?? [])})
    ON CONFLICT (id) DO NOTHING`
}

export async function readSentArchive(): Promise<SentMessage[]> {
  await ensureMailSchema()
  const sql = db()
  // The list never shows a body, and 500 bodies is tens of megabytes — the Sent folder
  // took half a minute to open once an archive had been imported.
  const rows = await sql`
    SELECT id, from_addr, to_addrs, cc, bcc, reply_to, subject, created_at, last_event
    FROM mail_sent ORDER BY created_at DESC LIMIT 500`
  return rows.map(row => ({
    id: String(row.id),
    from: (row.from_addr as string) ?? '',
    to: parseArray(row.to_addrs),
    cc: parseArray(row.cc),
    bcc: parseArray(row.bcc),
    replyTo: parseArray(row.reply_to),
    subject: (row.subject as string) ?? '',
    html: null,
    text: null,
    createdAt: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
    lastEvent: (row.last_event as string) ?? null,
  }))
}

// ── Sent-mail attribution (owner + automated flag + thread link) ─
export type SentMeta = { owner: string | null; isAuto: boolean; inReplyTo: string | null }

export async function recordSentMeta(
  emailId: string,
  owner: string | null,
  isAuto: boolean,
  inReplyTo?: string | null,
): Promise<void> {
  if (!emailId) return
  await ensureMailSchema()
  const sql = db()
  const normalizedInReplyTo = inReplyTo ? inReplyTo.replace(/[<>]/g, '').trim() || null : null
  await sql`
    INSERT INTO mail_sent_meta (email_id, owner, is_auto, in_reply_to, created_at)
    VALUES (${emailId}, ${owner ? owner.toLowerCase() : null}, ${isAuto}, ${normalizedInReplyTo}, ${nowIso()})
    ON CONFLICT (email_id) DO UPDATE SET
      owner = COALESCE(excluded.owner, mail_sent_meta.owner),
      is_auto = excluded.is_auto,
      in_reply_to = COALESCE(excluded.in_reply_to, mail_sent_meta.in_reply_to)`
}

/** Explicitly (re)assign a sent email to a mailbox owner, preserving its is_auto flag. */
export async function setSentMetaOwner(emailId: string, owner: string): Promise<void> {
  if (!emailId) return
  await ensureMailSchema()
  const sql = db()
  await sql`
    INSERT INTO mail_sent_meta (email_id, owner, created_at) VALUES (${emailId}, ${owner.trim().toLowerCase()}, ${nowIso()})
    ON CONFLICT (email_id) DO UPDATE SET owner = excluded.owner`
}

export async function readSentMessage(id: string): Promise<SentMessage | null> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    SELECT id, from_addr, to_addrs, cc, bcc, reply_to, subject, html, body_text, created_at, last_event
    FROM mail_sent WHERE id = ${id}`
  const row = rows[0]
  if (!row) return null
  return {
    id: String(row.id),
    from: (row.from_addr as string) ?? '',
    to: parseArray(row.to_addrs),
    cc: parseArray(row.cc),
    bcc: parseArray(row.bcc),
    replyTo: parseArray(row.reply_to),
    subject: (row.subject as string) ?? '',
    html: (row.html as string) ?? null,
    text: (row.body_text as string) ?? null,
    createdAt: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
    lastEvent: (row.last_event as string) ?? null,
  }
}

export async function readSentMeta(emailIds?: string[]): Promise<Record<string, SentMeta>> {
  await ensureMailSchema()
  const sql = db()
  // The caller only ever needs rows for the messages it is about to return. Unscoped,
  // this read the whole table — thirty-odd thousand rows — on every poll of every tab,
  // which is most of a month's read quota on its own.
  const safe = (emailIds ?? []).filter(id => /^[A-Za-z0-9._:+@-]{1,200}$/.test(id))
  const scope = emailIds ? ` WHERE email_id IN (${safe.map(id => `'${id}'`).join(',') || "''"})` : ''
  const rows = await sql`SELECT email_id, owner, is_auto, in_reply_to FROM mail_sent_meta${scope}`
  const out: Record<string, SentMeta> = {}
  for (const row of rows) {
    out[String(row.email_id)] = {
      owner: (row.owner as string) ?? null,
      isAuto: Boolean(row.is_auto),
      inReplyTo: (row.in_reply_to as string) ?? null,
    }
  }
  return out
}

export async function getAccountPasswordHash(email: string): Promise<string | undefined> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT password_hash FROM mail_accounts WHERE email = ${email.toLowerCase()}`
  const hash = rows[0]?.password_hash
  return hash === null || hash === undefined ? undefined : String(hash)
}

export async function setAccountPassword(email: string, passwordHash: string): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`
    UPDATE mail_accounts SET password_hash = ${passwordHash}, password_is_default = 0
    WHERE email = ${email.toLowerCase()}`
}

/** True while the account is still on the address-derived password it was seeded with. */
export async function usingDefaultPassword(email: string): Promise<boolean> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT password_is_default FROM mail_accounts WHERE email = ${email.toLowerCase()}`
  return Number(rows[0]?.password_is_default ?? 0) === 1
}


/** Every outstanding reset link for an address, dropped. Used after a password changes. */
export async function clearResetTokens(email: string): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`DELETE FROM mail_reset_tokens WHERE email = ${email.trim().toLowerCase()}`
}

export type ShareRecord = {
  id: string
  objectKey: string
  filename: string
  contentType: string | null
  size: number
  hasPassword: boolean
  expiresAt: string | null
  downloads: number
  maxDownloads: number | null
  revoked: boolean
}

function mapShare(row: Record<string, unknown>): ShareRecord {
  return {
    id: String(row.id),
    objectKey: String(row.object_key),
    filename: String(row.filename),
    contentType: row.content_type == null ? null : String(row.content_type),
    size: Number(row.size ?? 0),
    hasPassword: Boolean(row.password_hash),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    downloads: Number(row.downloads ?? 0),
    maxDownloads: row.max_downloads == null ? null : Number(row.max_downloads),
    revoked: Number(row.revoked ?? 0) === 1,
  }
}

export async function createShare(input: {
  id: string
  objectKey: string
  filename: string
  contentType?: string | null
  size: number
  passwordHash?: string | null
  owner: string
  expiresAt?: string | null
  maxDownloads?: number | null
}): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`
    INSERT INTO mail_shares (id, object_key, filename, content_type, size, password_hash, owner, created_at, expires_at, max_downloads)
    VALUES (${input.id}, ${input.objectKey}, ${input.filename}, ${input.contentType ?? null}, ${input.size},
            ${input.passwordHash ?? null}, ${input.owner.toLowerCase()}, ${nowIso()}, ${input.expiresAt ?? null},
            ${input.maxDownloads ?? null})`
}

export async function getShare(id: string): Promise<ShareRecord | null> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT * FROM mail_shares WHERE id = ${id}`
  return rows[0] ? mapShare(rows[0]) : null
}

/** The hash is never returned with the record, so it can only be read deliberately. */
export async function getSharePasswordHash(id: string): Promise<string | null> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT password_hash FROM mail_shares WHERE id = ${id}`
  const hash = rows[0]?.password_hash
  return hash == null ? null : String(hash)
}

export async function recordShareDownload(id: string): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`UPDATE mail_shares SET downloads = downloads + 1 WHERE id = ${id}`
}

export async function listShares(owner: string): Promise<ShareRecord[]> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    SELECT * FROM mail_shares WHERE owner = ${owner.toLowerCase()} ORDER BY created_at DESC LIMIT 100`
  return rows.map(mapShare)
}

export async function setSharePassword(id: string, owner: string, passwordHash: string | null): Promise<boolean> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    UPDATE mail_shares SET password_hash = ${passwordHash}
    WHERE id = ${id} AND owner = ${owner.toLowerCase()} RETURNING id`
  return rows.length > 0
}

export async function revokeShare(id: string, owner: string): Promise<boolean> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    UPDATE mail_shares SET revoked = 1 WHERE id = ${id} AND owner = ${owner.toLowerCase()} RETURNING id`
  return rows.length > 0
}

export async function createResetToken(email: string, token: string, expires: number): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`DELETE FROM mail_reset_tokens WHERE expires_at < ${nowIso()}`
  await sql`
    INSERT INTO mail_reset_tokens (token, email, expires_at)
    VALUES (${token}, ${email.toLowerCase()}, ${new Date(expires).toISOString()})`
}

/**
 * The address a live token belongs to, without consuming it, so the new password can be
 * checked against the account's own policy before the single-use token is spent.
 */
export async function resetTokenEmail(token: string): Promise<string | null> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    SELECT email FROM mail_reset_tokens WHERE token = ${token} AND expires_at > ${nowIso()}`
  const email = rows[0]?.email
  return email ? String(email) : null
}

/** Atomically consume a valid token and set the new password. Single-use, no race window. */
export async function resetPasswordWithToken(token: string, passwordHash: string): Promise<string | null> {
  await ensureMailSchema()
  const sql = db()
  const consumed = await sql`
    DELETE FROM mail_reset_tokens WHERE token = ${token} AND expires_at > ${nowIso()} RETURNING email`
  const email = consumed[0]?.email
  if (!email) return null
  await sql`
    INSERT INTO mail_accounts (email, password_hash, status, created_at) VALUES (${String(email)}, ${passwordHash}, 'active', ${nowIso()})
    ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash, status = 'active'`
  return String(email)
}

// ── Per-account stash: drafts + saved templates ────────────────
export async function readStash(owner: string, kind: string): Promise<StashItem[]> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    SELECT id, data, updated_at FROM mail_stash
    WHERE owner = ${owner.toLowerCase()} AND kind = ${kind}
    ORDER BY updated_at DESC`
  return rows.map(row => ({
    id: String(row.id),
    data: parseJson<unknown>(row.data, null),
    updatedAt: isoOrNull(row.updated_at) ?? new Date(0).toISOString(),
  }))
}

export async function upsertStash(owner: string, kind: string, id: string, data: unknown): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`
    INSERT INTO mail_stash (owner, kind, id, data, updated_at)
    VALUES (${owner.toLowerCase()}, ${kind}, ${id}, ${JSON.stringify(data)}, ${nowIso()})
    ON CONFLICT (owner, kind, id) DO UPDATE SET data = excluded.data, updated_at = ${nowIso()}`
}

export async function deleteStash(owner: string, kind: string, id: string): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`DELETE FROM mail_stash WHERE owner = ${owner.toLowerCase()} AND kind = ${kind} AND id = ${id}`
}

/**
 * Claims a webhook delivery id so the work behind it runs once. Storage is already
 * idempotent, but forwarding a copy on to the mailbox owner is not, so a provider
 * retrying a delivery it believes failed would otherwise send a second copy.
 *
 * The claim is a lease rather than a permanent mark. A serverless invocation can be
 * killed mid-flight — a platform timeout, a redeploy — and a claim that outlived its
 * process would refuse the retry and lose the message for good. An unfinished claim
 * older than the lease is therefore taken over rather than treated as a duplicate.
 */
const CLAIM_LEASE_MS = 10 * 60 * 1000

export async function claimWebhookEvent(id: string): Promise<boolean> {
  if (!id) return true
  await ensureMailSchema()

  const inserted = await sqlRaw(
    `INSERT INTO mail_webhook_events (id, handled_at, status) VALUES (?, ?, 'working')
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, nowIso()],
  )
  if (inserted.length > 0) return true

  const existing = await sqlRaw('SELECT handled_at, status FROM mail_webhook_events WHERE id = ?', [id])
  const row = existing[0]
  if (!row) return true
  if (String(row.status) === 'done') return false

  const startedAt = new Date(String(row.handled_at)).getTime()
  if (Number.isFinite(startedAt) && Date.now() - startedAt < CLAIM_LEASE_MS) return false

  // The attempt holding this never finished and its lease has run out. Take it over.
  await sqlRaw('UPDATE mail_webhook_events SET handled_at = ? WHERE id = ?', [nowIso(), id])
  return true
}

/** Marks the delivery finished, so later redeliveries of it are refused for good. */
export async function completeWebhookEvent(id: string): Promise<void> {
  if (!id) return
  await sqlRaw("UPDATE mail_webhook_events SET status = 'done', handled_at = ? WHERE id = ?", [nowIso(), id])
    .catch(() => {})
}

/** Hands the id back after a failed delivery, so the provider's retry is not treated as a duplicate. */
export async function releaseWebhookEvent(id: string): Promise<void> {
  if (!id) return
  await sqlRaw('DELETE FROM mail_webhook_events WHERE id = ?', [id]).catch(() => {})
}

/** Keeps the dedupe table bounded; retries never span anything close to this. */
export async function pruneWebhookEvents(days = 30): Promise<void> {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
  await sqlRaw('DELETE FROM mail_webhook_events WHERE handled_at < ?', [cutoff]).catch(() => {})
}

/** Replaces the stored attachment metadata, used when bytes are copied into the bucket after the fact. */
export async function setInboundAttachments(id: string, attachments: unknown[]): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  const json = JSON.stringify(attachments)
  await sql`UPDATE mail_inbox SET attachments = ${json}, attach_meta = ${json} WHERE id = ${id}`
}

/**
 * Copies attachment bytes the provider is still holding into our own bucket.
 *
 * Only messages the provider actually delivered can be recovered this way. Anything
 * imported from the mail archive carries an `mbox-` id and was never in their hands,
 * so those are skipped rather than counted as failures.
 *
 * Runs on the deployment rather than a laptop on purpose: the provider, the bucket and
 * this code are all in the same region, so the bytes never leave it.
 */
export async function backfillAttachments(limit: number, countRemaining = false): Promise<{
  scanned: number
  copied: number
  files: number
  bytes: number
  failed: number
  remaining: number | null
}> {
  await ensureMailSchema()
  const result = { scanned: 0, copied: 0, files: 0, bytes: 0, failed: 0, remaining: null as number | null }

  const pending = `
    FROM mail_inbox
    WHERE attachments IS NOT NULL AND attachments NOT IN ('', '[]')
      AND attachments NOT LIKE '%"unavailable"%'
      AND id NOT LIKE 'mbox-%'
      AND EXISTS (SELECT 1 FROM json_each(attachments) WHERE json_extract(value, '$.key') IS NULL)`

  if (countRemaining) {
    const counted = await sqlRaw(`SELECT COUNT(*) AS n ${pending}`)
    result.remaining = Number(counted[0]?.n ?? 0)
  }

  const rows = await sqlRaw(`SELECT id ${pending} ORDER BY received_at DESC LIMIT ?`, [limit])
  if (rows.length === 0) return result
  result.scanned = rows.length

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return result
  const { putObject } = await import('./r2')

  await Promise.all(
    rows.map(async row => {
      const id = String(row.id)
      try {
        const listing = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}/attachments`, {
          headers: { authorization: `Bearer ${apiKey}` },
        })
        if (!listing.ok) {
          result.failed += 1
          if (listing.status === 404) {
            const current = await getInboundAttachments(id).catch(() => [])
            await setInboundAttachments(id, current.map(entry => ({ ...entry, unavailable: true }))).catch(() => {})
          }
          return
        }
        const payload = (await listing.json()) as { data?: Array<Record<string, unknown>> }
        const listed = payload.data ?? []
        if (!listed.length) return
        const current = await getInboundAttachments(id).catch(() => [])

        const kept = await Promise.all(
          listed.map(async (entry, index) => {
            if (current[index]?.key) return current[index]
            const filename = String(entry.filename ?? 'attachment')
            const contentType = entry.content_type ? String(entry.content_type) : undefined
            const source = entry.download_url ? String(entry.download_url) : ''
            const meta: Record<string, unknown> = { filename, contentType, size: Number(entry.size ?? 0) }
            if (!source) return meta
            const binary = await fetch(source)
            if (!binary.ok) return meta
            const bytes = Buffer.from(await binary.arrayBuffer())
            const safeName = filename.replace(/[^\w.\- ]+/g, '_').slice(-120)
            const key = `attachments/${id}/${index}-${safeName}`
            if (!(await putObject(key, bytes, contentType))) return meta
            result.files += 1
            result.bytes += bytes.length
            return { ...meta, size: bytes.length, key }
          }),
        )

        if (kept.some(entry => entry.key)) {
          await setInboundAttachments(id, kept)
          result.copied += 1
        }
      } catch {
        result.failed += 1
      }
    }),
  )

  return result
}

/** The files recorded against a message we sent, by the bucket keys we uploaded them to. */
export async function getSentAttachments(
  id: string,
): Promise<Array<{ filename: string; size?: number; contentType?: string; key?: string }>> {
  await ensureMailSchema()
  const rows = await sqlRaw('SELECT attachments FROM mail_sent WHERE id = ?', [id])
  const parsed = parseJson<unknown>(rows[0]?.attachments, [])
  return Array.isArray(parsed) ? (parsed as Array<{ filename: string; key?: string }>) : []
}
