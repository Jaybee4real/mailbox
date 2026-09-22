import { ADDRESS_ALIASES, MAIL_SEATS, type MailRole } from './brand'
/**
 * Durable mail state on libSQL (SQLite). Inbox, delivery events, account
 * credentials, reset tokens, and a per-account stash for drafts + saved templates.
 *
 * SQLite differences that matter here: booleans are 0/1, JSON columns are TEXT and come
 * back as strings (Postgres jsonb arrived pre-parsed), and timestamps are ISO strings
 * supplied by the app rather than `now()`.
 */

import { stripCidPlaceholders } from './email-html'
import { hashPassword } from './password'
import { duration, type ParsedQuery } from '@/app/mail/search'
import { turso, tursoBatch, tursoQuery } from './turso'
import { subjectKey, threadIdFor, THREAD_GAP_MS } from './threads'

export type InboundAttachment = { filename: string; contentType?: string; size?: number; shareId?: string }

export type InboundEmail = {
  snoozedUntil?: string | null
  id: string
  from: string
  to: string[]
  cc: string[]
  /** Written to, copied in, or neither — from the holding mailbox's point of view. */
  addressed?: Addressed
  /** What the spam, virus and sender-authentication checks said. */
  risk?: Risk
  riskReasons?: string[]
  /** Held out of the inbox entirely, rather than only labelled. */
  spam?: boolean
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

export function db() {
  return turso()
}

/** Raw SQL with positional args, for queries whose shape is built at runtime. */
function tagged(_sql: unknown, text: string, args: unknown[]): Promise<Record<string, unknown>[]> {
  return tursoQuery(text, args)
}

function sqlRaw(text: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  return tursoQuery(text, args)
}

function dbBatch(statements: string[]): Promise<void> {
  return tursoBatch(statements)
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
 * Create the schema on first use. There is no migration runner, but unlike the Postgres
 * original we own the full CREATE, so there are no incremental ALTERs to replay.
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
        // Trash and Starred cannot use the list index: archived sits ahead of trashed in it
        // and is unconstrained for those two folders, so SQLite fell back to walking the
        // mailbox in date order — 45,000 rows read to find the 52 that were in the bin.
        `CREATE INDEX IF NOT EXISTS mail_inbox_owner_trash_idx ON mail_inbox (lower(owner), trashed, received_at DESC, id DESC)`,
        `CREATE INDEX IF NOT EXISTS mail_inbox_owner_starred_idx ON mail_inbox (lower(owner), starred, trashed, received_at DESC, id DESC)`,
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
        // What this mailbox has learned about a correspondent by handling their mail.
        // Judgement comes from here first and from fixed rules second, so the same sender
        // can be trusted in one mailbox and refused in another.
        `CREATE TABLE IF NOT EXISTS mail_sender_reputation (
          owner TEXT NOT NULL,
          domain TEXT NOT NULL,
          received INTEGER NOT NULL DEFAULT 0,
          trashed INTEGER NOT NULL DEFAULT 0,
          marked_spam INTEGER NOT NULL DEFAULT 0,
          replied INTEGER NOT NULL DEFAULT 0,
          first_seen TEXT,
          last_seen TEXT,
          PRIMARY KEY (owner, domain)
        )`,
        `CREATE TABLE IF NOT EXISTS mail_counts_cache (
          owner TEXT PRIMARY KEY,
          computed_at TEXT NOT NULL,
          counts TEXT NOT NULL
        )`,
        // Sending later is ours to keep, not the provider's. SES has no notion of it and
        // dropped the instruction silently; Brevo refuses outright; a Resend-shaped host
        // may or may not honour it. Parking the prepared message here means the delay
        // behaves the same whoever carries the mail in the end.
        `CREATE TABLE IF NOT EXISTS mail_scheduled (
          id TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          send_after TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          payload TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          sent_id TEXT,
          created_at TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS mail_scheduled_due_idx ON mail_scheduled (status, send_after)`,
        `CREATE INDEX IF NOT EXISTS mail_scheduled_owner_idx ON mail_scheduled (lower(owner), send_after)`,
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
      // Whether the mailbox was actually written to, or only copied. Stored rather than
      // worked out per query: matching an address inside the cc JSON means a scan, and a
      // mailbox here holds six figures of mail.
      await sqlRaw("ALTER TABLE mail_inbox ADD COLUMN addressed TEXT").catch(() => {})
      // What the scanners and the sender's own domain said about this message.
      await sqlRaw("ALTER TABLE mail_inbox ADD COLUMN risk TEXT").catch(() => {})
      // High-confidence spam is held out of the inbox rather than merely labelled.
      await sqlRaw("ALTER TABLE mail_inbox ADD COLUMN spam INTEGER NOT NULL DEFAULT 0").catch(() => {})
      await sqlRaw("CREATE INDEX IF NOT EXISTS mail_inbox_spam_idx ON mail_inbox (lower(owner), spam, received_at DESC)").catch(() => {})
      await sqlRaw("ALTER TABLE mail_inbox ADD COLUMN risk_reasons TEXT").catch(() => {})
      // The row in the list follows its newest message, so the conversation carries it too.
      await sqlRaw("ALTER TABLE mail_threads ADD COLUMN addressed TEXT").catch(() => {})
      // Worst verdict in the conversation, so a warning cannot hide behind a later reply.
      await sqlRaw("ALTER TABLE mail_threads ADD COLUMN risk TEXT").catch(() => {})
      await sqlRaw("ALTER TABLE mail_threads ADD COLUMN spam_count INTEGER NOT NULL DEFAULT 0").catch(() => {})
      await sqlRaw('CREATE INDEX IF NOT EXISTS mail_inbox_addressed_idx ON mail_inbox (lower(owner), addressed, received_at DESC)')
        .catch(() => {})
      // Where a reset link goes when the account's own mailbox is the thing locked.
      await sqlRaw('ALTER TABLE mail_accounts ADD COLUMN recovery_email TEXT').catch(() => {})
      await sqlRaw('ALTER TABLE mail_accounts ADD COLUMN recovery_verified INTEGER NOT NULL DEFAULT 0').catch(() => {})
      // A link mailed to an unproven address must not be able to set a password.
      await sqlRaw("ALTER TABLE mail_reset_tokens ADD COLUMN purpose TEXT NOT NULL DEFAULT 'reset'").catch(() => {})
      await sqlRaw("ALTER TABLE mail_webhook_events ADD COLUMN status TEXT NOT NULL DEFAULT 'working'")
        .catch(() => {})
      await sqlRaw('ALTER TABLE mail_sent ADD COLUMN attachments TEXT').catch(() => {})

      // Drawing a list row needed the whole message: 24KB of body to show 320 characters
      // of it, 5KB of headers to read three of them, and the attachment list to learn
      // whether there was one. These hold just those answers.
      await sqlRaw('ALTER TABLE mail_inbox ADD COLUMN snippet TEXT').catch(() => {})
      await sqlRaw('ALTER TABLE mail_inbox ADD COLUMN thread_meta TEXT').catch(() => {})
      await sqlRaw('ALTER TABLE mail_inbox ADD COLUMN attach_meta TEXT').catch(() => {})
      // thread_id arrives by migration, so its index has to follow the column rather than
      // sit in the batch above, where a fresh database has no such column yet.
      await sqlRaw('ALTER TABLE mail_inbox ADD COLUMN thread_id TEXT').catch(() => {})
      await sqlRaw('CREATE INDEX IF NOT EXISTS mail_inbox_thread_idx ON mail_inbox (lower(owner), thread_id, received_at DESC, id DESC)').catch(() => {})

      // Snooze. An ISO timestamp in the future means "not now": the message is out of the
      // inbox until then and comes back on its own, because every folder decides from this
      // column against the clock rather than from a flag some worker has to flip. There is
      // no job to fall behind, and nothing to reconcile if one does.
      await sqlRaw('ALTER TABLE mail_inbox ADD COLUMN snoozed_until TEXT').catch(() => {})
      await sqlRaw('ALTER TABLE mail_threads ADD COLUMN snoozed_until TEXT').catch(() => {})
      await sqlRaw('CREATE INDEX IF NOT EXISTS mail_inbox_snoozed_idx ON mail_inbox (lower(owner), snoozed_until, received_at DESC, id DESC)').catch(() => {})
      await sqlRaw('CREATE INDEX IF NOT EXISTS mail_threads_snoozed_idx ON mail_threads (owner, snoozed_until, latest_at DESC)').catch(() => {})

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

export type SenderStanding = {
  received: number
  trashed: number
  markedSpam: number
  replied: number
  firstSeen: string | null
}

/** What this mailbox has done with this sender's domain before. */
export async function senderStanding(owner: string | null, domain: string): Promise<SenderStanding> {
  const empty = { received: 0, trashed: 0, markedSpam: 0, replied: 0, firstSeen: null }
  if (!owner || !domain) return empty
  await ensureMailSchema()
  const rows = await db()`
    SELECT received, trashed, marked_spam, replied, first_seen FROM mail_sender_reputation
    WHERE owner = ${owner.toLowerCase()} AND domain = ${domain.toLowerCase()}`
  const row = rows[0]
  if (!row) return empty
  return {
    received: Number(row.received ?? 0),
    trashed: Number(row.trashed ?? 0),
    markedSpam: Number(row.marked_spam ?? 0),
    replied: Number(row.replied ?? 0),
    firstSeen: row.first_seen == null ? null : String(row.first_seen),
  }
}

/** Records one more thing this mailbox did with a sender. Every judgement feeds the next. */
export async function noteSender(
  owner: string | null,
  domain: string,
  what: 'received' | 'trashed' | 'marked_spam' | 'replied',
): Promise<void> {
  if (!owner || !domain) return
  await ensureMailSchema()
  const now = nowIso()
  const sql = db()
  await sql`
    INSERT INTO mail_sender_reputation (owner, domain, received, trashed, marked_spam, replied, first_seen, last_seen)
    VALUES (${owner.toLowerCase()}, ${domain.toLowerCase()},
      ${what === 'received' ? 1 : 0}, ${what === 'trashed' ? 1 : 0},
      ${what === 'marked_spam' ? 1 : 0}, ${what === 'replied' ? 1 : 0}, ${now}, ${now})
    ON CONFLICT (owner, domain) DO UPDATE SET
      received = mail_sender_reputation.received + ${what === 'received' ? 1 : 0},
      trashed = mail_sender_reputation.trashed + ${what === 'trashed' ? 1 : 0},
      marked_spam = mail_sender_reputation.marked_spam + ${what === 'marked_spam' ? 1 : 0},
      replied = mail_sender_reputation.replied + ${what === 'replied' ? 1 : 0},
      last_seen = ${now}`
}

/** What the scanners and the sender's own domain said. */
export type Risk = 'clean' | 'suspicious' | 'spam' | 'virus'

export type RiskSignals = {
  spam?: string | null
  virus?: string | null
  spf?: string | null
  dkim?: string | null
  dmarc?: string | null
  /** The message itself, for the tells authentication cannot see. */
  from?: string | null
  replyTo?: string[] | null
  subject?: string | null
  text?: string | null
}

/** Defaults only. Each is overridable per deployment, so a list can change without a
 *  release — metroperil can drop a word its own trade uses every day. */
const FREE_MAIL_DEFAULT = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com',
  'live.com', 'aol.com', 'protonmail.com', 'proton.me', 'mail.com', 'gmx.com', 'yandex.com',
  'icloud.com', 'zoho.com', 'inbox.lv', 'consultant.com', 'qq.com', '163.com',
])

const THROWAWAY_TLDS_DEFAULT = new Set([
  'xyz', 'top', 'buzz', 'click', 'link', 'work', 'gq', 'cf', 'ml', 'tk', 'ga',
  'loan', 'men', 'date', 'racing', 'win', 'stream', 'download', 'review', 'country', 'kim',
])

/** The shape of an advance-fee approach. Counted, never single-word: one alone is innocent. */
// Only wording that is odd in ordinary business correspondence belongs here. A single
// generic term is not evidence of anything: an insurance broker writes "beneficiary" and
// "bank draft" all day, a logistics firm writes "consignment", and every sales team sends
// a "business proposal". Add them per deployment through MAIL_SCAM_PHRASES if a mailbox
// genuinely never sees them.
const SCAM_PHRASES_DEFAULT = [
  'next of kin', 'sole beneficiary', 'late client', 'deceased client',
  'inheritance', 'died without', 'without a will', 'unclaimed inheritance',
  'winning notification', 'lottery winner', 'western union', 'atm card',
  'transfer to your account immediately', 'strictly confidential and urgent',
]

/** The registrable domain behind an address, for reputation to be keyed on. */
export const senderDomainOf = (address: string): string => registrable(domainOf(address))

const domainOf = (address: string): string => {
  const angled = address.match(/<([^>]+)>/)
  const bare = (angled ? angled[1] : address).trim().toLowerCase()
  return bare.split('@').pop() ?? ''
}

/** example.co.uk and example.com both reduce to the name somebody actually registered. */
const registrable = (host: string): string => {
  const parts = host.split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  const twoLevel = /^(co|com|org|net|gov|ac|edu|ltd|plc)\.[a-z]{2}$/.test(parts.slice(-2).join('.'))
  return parts.slice(twoLevel ? -3 : -2).join('.')
}

const failed = (verdict: string | null | undefined): boolean =>
  typeof verdict === 'string' && /^(fail|softfail|permerror)$/i.test(verdict.trim())

const listFrom = (raw: string | undefined, fallback: Iterable<string>): Set<string> => {
  const parsed = (raw ?? '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean)
  return parsed.length ? new Set(parsed) : new Set(fallback)
}

// Read per call, so a deployment can change any of them without a release.
const freeProviders = () => listFrom(process.env.MAIL_FREE_PROVIDERS, FREE_MAIL_DEFAULT)
const throwawayTlds = () => listFrom(process.env.MAIL_THROWAWAY_TLDS, THROWAWAY_TLDS_DEFAULT)

// Bulk senders put their own bounce domain in From and the real correspondent in Reply-To.
// That is how the campaign gets replies, not an attempt to redirect them somewhere unexpected.
const BULK_SENDERS_DEFAULT = new Set([
  'mailchimpapp.com', 'mcsv.net', 'rsgsv.net', 'mailchimp.com',
  'sendgrid.net', 'sendgrid.com', 'sparkpostmail.com', 'amazonses.com',
  'mailgun.org', 'mandrillapp.com', 'postmarkapp.com', 'sendinblue.com',
  'brevo.com', 'constantcontact.com', 'cmail19.com', 'createsend.com',
  'hubspotemail.net', 'mailerlite.com', 'klaviyomail.com', 'salesforce.com',
])
const bulkSenders = () => listFrom(process.env.MAIL_BULK_SENDERS, BULK_SENDERS_DEFAULT)
const scamPhrases = () => [...listFrom(process.env.MAIL_SCAM_PHRASES, SCAM_PHRASES_DEFAULT)]

/** Weight at which a message stops being labelled and is held out of the inbox instead. */
const quarantineAt = () => Number(process.env.MAIL_SPAM_THRESHOLD ?? 6)

/** Below this nothing is said at all. One small oddity is not a case. */
const flagAt = () => Number(process.env.MAIL_SUSPICION_THRESHOLD ?? 3)

export type RiskJudgement = { risk: Risk; reasons: string[]; score: number; quarantine: boolean }

/**
 * What this mailbox knows, then what is true of the message. The standing a sender has
 * built here leads: somebody you have written back to is not spam because their subject
 * shouts, and somebody whose mail you have binned repeatedly does not get the benefit of
 * the doubt again. The fixed rules only decide the cases with no history to go on, and
 * every one of their lists can be changed per deployment without a release.
 */
export function judgeMessage(signals: RiskSignals, standing: SenderStanding): RiskJudgement {
  const reasons: string[] = []
  let score = 0
  // A finding is "telling" when it is hard to trip by accident. Failing an authentication
  // check or shouting in the subject line is neither: ordinary mail does both. Holding a
  // message back takes at least one finding of the first kind, however the weights add up.
  let telling = 0
  const add = (weight: number, why: string, isTelling = false) => {
    score += weight
    if (isTelling) telling += 1
    reasons.push(why)
  }

  if (/^fail$/i.test((signals.virus ?? '').trim())) {
    return { risk: 'virus', reasons: ['A virus scan failed on this message'], score: 100, quarantine: true }
  }

  // Trust is earned by being written back to, never by volume alone: a sender whose mail
  // arrives forty times and is binned every time has not earned anything.
  const trusted = standing.replied > 0 && standing.markedSpam === 0
  if (standing.markedSpam > 0) {
    add(4 + Math.min(standing.markedSpam, 4),
      `You marked ${standing.markedSpam} earlier message${standing.markedSpam === 1 ? '' : 's'} from this sender as spam`, true)
  } else if (standing.trashed >= 3 && standing.replied === 0) {
    add(3, `You have deleted ${standing.trashed} messages from this sender without ever replying`, true)
  }

  if (/^fail$/i.test((signals.spam ?? '').trim())) add(4, 'The provider\u2019s spam filter flagged this message', true)

  const authenticated = /^pass$/i.test((signals.dmarc ?? '').trim())
  // Heavy, but not enough on its own to hide a message: mail forwarded through a list
  // breaks alignment and fails DMARC while being perfectly legitimate. It warns loudly;
  // it takes a second finding to put a message out of sight.
  if (failed(signals.dmarc)) add(4, 'The sending domain says this message is not from them (DMARC failed)')
  else if (!authenticated) {
    if (failed(signals.spf)) add(2, 'The sending server is not authorised by that domain (SPF failed)')
    if (failed(signals.dkim)) add(2, 'The signature does not match the sending domain (DKIM failed)')
  }

  const fromDomain = registrable(domainOf(signals.from ?? ''))
  const replyDomains = (signals.replyTo ?? [])
    .map(entry => registrable(domainOf(entry)))
    .filter(entry => entry && entry !== fromDomain)
  const free = freeProviders()
  const freeReply = replyDomains.find(entry => free.has(entry))
  const bulk = bulkSenders().has(fromDomain)
  if (bulk) {
    // Nothing to say: a campaign's replies are meant to land somewhere other than the
    // sending platform, and treating that as misdirection buries ordinary bulk mail.
  } else if (freeReply && fromDomain && !free.has(fromDomain)) {
    add(4, `Replies to this message go to ${freeReply}, not to ${fromDomain}`, true)
  } else if (replyDomains.length) {
    add(1, `Replies go to ${replyDomains[0]} rather than ${fromDomain || 'the sender'}`)
  }

  const tld = fromDomain.split('.').pop() ?? ''
  if (throwawayTlds().has(tld)) add(2, `The sender\u2019s domain ends in .${tld}, which is cheap to register and often disposable`, true)
  if (/^\d{4,}$/.test(fromDomain.split('.')[0] ?? '')) add(2, 'The sender\u2019s domain name is just a string of digits', true)

  const subject = (signals.subject ?? '').trim()
  const letters = subject.replace(/[^A-Za-z]/g, '')
  if (letters.length >= 12 && letters === letters.toUpperCase()) add(1, 'The subject is written entirely in capitals')

  const body = (signals.text ?? '').toLowerCase()
  const hits = scamPhrases().filter(phrase => body.includes(phrase))
  if (hits.length >= 2) add(3, `The wording follows a known advance-fee approach (${hits.slice(0, 3).join(', ')})`, true)
  else if (hits.length === 1) add(1, `Wording associated with advance-fee mail (${hits[0]})`)

  // Never heard from before is not suspicious by itself — everyone writes once for the
  // first time — but it is what turns a couple of small oddities into a pattern.
  if (!trusted && standing.received <= 1 && score > 0) add(1, 'This is the first message from this sender')

  // Someone this mailbox corresponds with is forgiven the small stuff; only findings heavy
  // enough to stand on their own still count against them.
  const limit = quarantineAt()
  if (trusted && score < limit) return { risk: 'clean', reasons: [], score: 0, quarantine: false }

  // One small oddity is not a case to answer. A subject in capitals from somebody writing
  // for the first time is a stranger in a hurry, not a scam, and saying otherwise every
  // time teaches the reader to ignore the warning.
  if (score < flagAt()) return { risk: 'clean', reasons: [], score, quarantine: false }

  const quarantine = score >= limit && telling > 0
  return { risk: quarantine ? 'spam' : 'suspicious', reasons, score, quarantine }
}


/** How the mailbox came to hold a message, from that mailbox's own point of view. */
export type Addressed = 'direct' | 'copied' | 'other'

const bare = (raw: string): string => {
  const angled = raw.match(/<([^>]+)>/)
  return (angled ? angled[1] : raw).trim().toLowerCase()
}

/**
 * Written to, copied in, or neither. The third case is real and common — a blind copy, a
 * distribution list, an alias, or mail caught by the shared address — and calling it a
 * copy would be a guess dressed as a fact, so it gets its own answer.
 *
 * Judged against the mailbox that holds the message, never the person reading it: an
 * administrator reading everyone's mail must not be told they were copied on someone
 * else's.
 */
export function classifyAddressed(
  owner: string | null | undefined,
  to: string[],
  cc: string[],
): Addressed {
  const seat = (owner ?? '').trim().toLowerCase()
  if (!seat) return 'other'
  if (to.some(entry => bare(entry) === seat)) return 'direct'
  if (cc.some(entry => bare(entry) === seat)) return 'copied'
  return 'other'
}

function mapInbound(row: Record<string, unknown>): InboundEmail {
  return {
    id: String(row.id),
    from: (row.from_addr as string) ?? '',
    to: parseArray(row.to_addrs),
    cc: parseArray(row.cc),
    addressed: (['direct', 'copied', 'other'].includes(String(row.addressed))
      ? String(row.addressed)
      : classifyAddressed(row.owner == null ? null : String(row.owner), parseArray(row.to_addrs), parseArray(row.cc))) as Addressed,
    risk: (['clean', 'suspicious', 'spam', 'virus'].includes(String(row.risk)) ? String(row.risk) : 'clean') as Risk,
    riskReasons: parseJson<string[]>(row.risk_reasons, []),
    spam: Boolean(row.spam),
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
    snoozedUntil: row.snoozed_until == null ? null : String(row.snoozed_until),
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
  folder?: 'inbox' | 'archive' | 'trash' | 'starred' | 'snoozed' | 'spam'
  unread?: boolean
  starred?: boolean
  hasAttachment?: boolean
  label?: string
  from?: string
  to?: string
  /** direct | copied | other, or 'not-copied' to leave copies out. */
  addressed?: string
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
  // Filtered in the query, not in the browser: a client-side pass would only ever narrow
  // the page already loaded, which on a mailbox of six figures reads as a broken filter.
  if (options.addressed === 'not-copied') where.push("COALESCE(m.addressed, 'other') <> 'copied'")
  else if (options.addressed) { where.push("COALESCE(m.addressed, 'other') = ?"); args.push(options.addressed) }

  // A snoozed message is only out of the inbox while its time is still ahead; the clause
  // does the waking, so nothing has to run on a timer.
  const nowIso = new Date().toISOString()
  const awake = "(m.snoozed_until IS NULL OR m.snoozed_until <= ?)"
  // Quarantined mail belongs to exactly one folder and appears in no other, or holding it
  // back would be pointless — it would still be sitting in the inbox under a label.
  if (options.folder === 'spam') where.push('m.spam = 1 AND m.trashed = 0')
  else if (options.folder === 'trash') where.push('m.trashed = 1')
  else if (options.folder === 'archive') where.push('m.archived = 1 AND m.trashed = 0 AND m.spam = 0')
  else if (options.folder === 'starred') where.push('m.starred = 1 AND m.trashed = 0 AND m.spam = 0')
  else if (options.folder === 'snoozed') { where.push('m.snoozed_until > ? AND m.trashed = 0 AND m.spam = 0'); args.push(nowIso) }
  else if (options.folder === 'inbox') { where.push(`m.archived = 0 AND m.trashed = 0 AND m.spam = 0 AND ${awake}`); args.push(nowIso) }

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
            m.starred, m.archived, m.trashed, m.snoozed_until, m.labels, m.owner, m.thread_id,
            m.addressed, m.risk, m.risk_reasons, m.spam
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

export type FolderTally = {
  inbox: number
  unread: number
  starred: number
  archived: number
  trashed: number
  spam: number
  snoozed: number
}

/**
 * `conversations` is null when threads are not live, because `mail_threads` is then either
 * empty or half-built and counting it would report a mailbox smaller than it is.
 */
export type FolderCounts = FolderTally & { conversations: FolderTally | null }

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
  try {
    const sql = db()
    // The '*all' row sums every mailbox, so one person's mail moving makes it wrong too.
    // Dropping only the owner's row left the all-inboxes view quoting figures from before
    // the delete, and an owner of null dropped nothing at all.
    if (owner) await sql`DELETE FROM mail_counts_cache WHERE owner = ${owner.toLowerCase()}`
    await sql`DELETE FROM mail_counts_cache WHERE owner = '*all'`
  } catch {
  }
}

export async function countFoldersCached(owner: string | null): Promise<FolderCounts> {
  await ensureMailSchema()
  const sql = db()
  const key = owner === null ? '*all' : owner.toLowerCase()
  const hit = await sql`SELECT computed_at, counts FROM mail_counts_cache WHERE owner = ${key}`
  const row = hit[0]
  if (row && Date.now() - Date.parse(String(row.computed_at)) < COUNTS_CACHE_MS) {
    const parsed = parseJson<FolderCounts | null>(row.counts, null)
    // A row cached before conversations were counted has no such key; recompute rather
    // than serve a shape the caller will read as "threads are not live".
    if (parsed && 'conversations' in parsed) return parsed
  }
  const fresh = await countFolders(owner ?? undefined)
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
  const nowIso = new Date().toISOString()

  // One pass, not one per folder: five separate counts read the table five times
  // (206k rows against 69k here) for figures that all come off the same scan.
  const rows = await tagged(
    sql,
    `SELECT
       SUM(CASE WHEN archived = 0 AND trashed = 0 AND spam = 0 AND (snoozed_until IS NULL OR snoozed_until <= ?) THEN 1 ELSE 0 END) AS inbox,
       SUM(CASE WHEN archived = 0 AND trashed = 0 AND spam = 0 AND read = 0 AND (snoozed_until IS NULL OR snoozed_until <= ?) THEN 1 ELSE 0 END) AS unread,
       SUM(CASE WHEN starred = 1 AND trashed = 0 AND spam = 0 THEN 1 ELSE 0 END) AS starred,
       SUM(CASE WHEN archived = 1 AND trashed = 0 AND spam = 0 THEN 1 ELSE 0 END) AS archived,
       SUM(CASE WHEN trashed = 1 THEN 1 ELSE 0 END) AS trashed,
       SUM(CASE WHEN spam = 1 AND trashed = 0 THEN 1 ELSE 0 END) AS spam,
       SUM(CASE WHEN snoozed_until > ? AND trashed = 0 AND spam = 0 THEN 1 ELSE 0 END) AS snoozed
     FROM mail_inbox ${scope}`,
    [nowIso, nowIso, nowIso, ...args],
  )
  const row = rows[0] ?? {}
  const value = (key: string) => Number((row[key] as number) ?? 0)

  // The list shows one row per conversation, so the figure beside a folder has to be
  // conversations too. Counted in messages it disagreed with the list header by three to
  // one on the larger mailboxes, and the unread badge could exceed the folder total.
  // The predicates are the ones listThreads pages by; they must not drift apart.
  let conversations: FolderTally | null = null
  if (threadsLive() && owner) {
    const threadRows = await tagged(
      sql,
      `SELECT
         SUM(CASE WHEN inbox_count > 0 AND (snoozed_until IS NULL OR snoozed_until <= ?) THEN 1 ELSE 0 END) AS inbox,
         SUM(CASE WHEN inbox_count > 0 AND unread_count > 0 AND (snoozed_until IS NULL OR snoozed_until <= ?) THEN 1 ELSE 0 END) AS unread,
         SUM(CASE WHEN starred_count > 0 THEN 1 ELSE 0 END) AS starred,
         SUM(CASE WHEN archived_count > 0 THEN 1 ELSE 0 END) AS archived,
         SUM(CASE WHEN trashed_count > 0 THEN 1 ELSE 0 END) AS trashed,
         0 AS spam,
         SUM(CASE WHEN snoozed_until > ? THEN 1 ELSE 0 END) AS snoozed
       FROM mail_threads WHERE owner = ?`,
      [nowIso, nowIso, nowIso, owner.toLowerCase()],
    )
    const threadRow = threadRows[0] ?? {}
    const threadValue = (key: string) => Number((threadRow[key] as number) ?? 0)
    conversations = {
      inbox: threadValue('inbox'),
      unread: threadValue('unread'),
      starred: threadValue('starred'),
      archived: threadValue('archived'),
      trashed: threadValue('trashed'),
      spam: threadValue('spam'),
      snoozed: threadValue('snoozed'),
    }
  }

  return {
    inbox: value('inbox'),
    unread: value('unread'),
    starred: value('starred'),
    archived: value('archived'),
    trashed: value('trashed'),
    spam: value('spam'),
    snoozed: value('snoozed'),
    conversations,
  }
}

export async function readInbox(filter?: { owner?: string }): Promise<InboundEmail[]> {
  await ensureMailSchema()
  const sql = db()
  const owner = filter?.owner?.trim().toLowerCase()
  const rows = owner
    ? await sql`
        SELECT id, from_addr, to_addrs, cc, bcc, reply_to, subject, html, body_text, headers, received_at, read, attachments, starred, archived, trashed, labels, owner, thread_id, addressed, risk, risk_reasons, spam
        FROM mail_inbox WHERE lower(owner) = ${owner} ORDER BY received_at DESC LIMIT ${MAX_INBOX}`
    : await sql`
        SELECT id, from_addr, to_addrs, cc, bcc, reply_to, subject, html, body_text, headers, received_at, read, attachments, starred, archived, trashed, labels, owner, thread_id, addressed, risk, risk_reasons, spam
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
  spamCount: number
  attachCount: number
  senders: string[]
  snippet: string
  labels: string[]
  snoozedUntil: string | null
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
      SUM(CASE WHEN read = 0 AND trashed = 0 AND spam = 0 THEN 1 ELSE 0 END) AS unread,
      SUM(CASE WHEN starred = 1 AND trashed = 0 AND spam = 0 THEN 1 ELSE 0 END) AS starred,
      SUM(CASE WHEN archived = 0 AND trashed = 0 AND spam = 0 THEN 1 ELSE 0 END) AS inbox,
      SUM(CASE WHEN archived = 1 AND trashed = 0 AND spam = 0 THEN 1 ELSE 0 END) AS archived,
      SUM(CASE WHEN spam = 1 THEN 1 ELSE 0 END) AS spam,
      SUM(CASE WHEN trashed = 1 THEN 1 ELSE 0 END) AS trashed,
      SUM(CASE WHEN attachments IS NOT NULL AND attachments NOT IN ('', '[]') THEN 1 ELSE 0 END) AS attach,
      MAX(CASE risk WHEN 'virus' THEN 3 WHEN 'spam' THEN 2 WHEN 'suspicious' THEN 1 ELSE 0 END) AS worst_risk,
      MIN(received_at) AS first_at, MAX(received_at) AS latest_at
    FROM mail_inbox WHERE lower(owner) = ${owner} AND thread_id = ${threadId}`
  const total = Number(agg[0]?.n ?? 0)
  if (total === 0) {
    await sql`DELETE FROM mail_threads WHERE owner = ${owner} AND thread_id = ${threadId}`
    return
  }
  const latest = await sql`
    SELECT id, subject, addressed, COALESCE(snippet, substr(COALESCE(body_text, ''), 1, 320)) AS snippet
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
      unread_count, starred_count, inbox_count, archived_count, trashed_count, spam_count, attach_count, senders, snippet, labels, addressed, risk)
    VALUES (${owner}, ${threadId}, ${subjectKey(String(head?.subject ?? ''))}, ${head?.subject ?? null},
      ${String(agg[0].first_at)}, ${String(agg[0].latest_at)}, ${head?.id ?? null}, ${total},
      ${Number(agg[0].unread ?? 0)}, ${Number(agg[0].starred ?? 0)}, ${Number(agg[0].inbox ?? 0)},
      ${Number(agg[0].archived ?? 0)}, ${Number(agg[0].trashed ?? 0)}, ${Number(agg[0].spam ?? 0)}, ${Number(agg[0].attach ?? 0)},
      ${JSON.stringify(senders)}, ${String(head?.snippet ?? '')}, ${JSON.stringify([...labels])},
      ${head?.addressed == null ? null : String(head.addressed)},
      ${['clean', 'suspicious', 'spam', 'virus'][Number(agg[0]?.worst_risk ?? 0)] ?? 'clean'})
    ON CONFLICT (owner, thread_id) DO UPDATE SET
      subject_key = excluded.subject_key, subject = excluded.subject, first_at = excluded.first_at,
      latest_at = excluded.latest_at, latest_id = excluded.latest_id, count = excluded.count,
      unread_count = excluded.unread_count, starred_count = excluded.starred_count,
      inbox_count = excluded.inbox_count, archived_count = excluded.archived_count,
      trashed_count = excluded.trashed_count, spam_count = excluded.spam_count, attach_count = excluded.attach_count,
      senders = excluded.senders, snippet = excluded.snippet, labels = excluded.labels,
      addressed = excluded.addressed, risk = excluded.risk`
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
    // A reply to a conversation someone put aside is the reason to stop putting it aside.
    await setThreadSnooze(row.owner, threadId, null)
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

export type ThreadFolder = 'inbox' | 'archive' | 'trash' | 'starred' | 'snoozed' | 'spam'

/** The newest conversations in a folder: one row each, already summarised. */
export type ThreadPage = { rows: ThreadRow[]; nextCursor: string | null }

export async function listThreads(ownerRaw: string | null, folder: ThreadFolder, limit: number, cursorRaw?: string | null): Promise<ThreadPage> {
  await ensureMailSchema()
  const owner = ownerRaw === null ? null : ownerRaw.toLowerCase()
  const nowIso = new Date().toISOString()
  const predicate =
    folder === 'spam' ? 'spam_count > 0'
    : folder === 'archive' ? 'archived_count > 0'
    : folder === 'trash' ? 'trashed_count > 0'
    : folder === 'starred' ? 'starred_count > 0'
    : folder === 'snoozed' ? 'snoozed_until > ?'
    : 'inbox_count > 0 AND (snoozed_until IS NULL OR snoozed_until <= ?)'
  // Both snooze predicates carry one bound timestamp; the others carry none, and the
  // cursor's arguments have to follow whatever the predicate used.
  const folderArgs = folder === 'snoozed' || folder === 'inbox' ? [nowIso] : []
  const cursor = decodeCursor(cursorRaw)
  const cursorClause = cursor ? '(latest_at < ? OR (latest_at = ? AND thread_id < ?))' : ''
  const cursorArgs = cursor ? [cursor.receivedAt, cursor.receivedAt, cursor.id] : []
  // Thread rows are materialised per owner, so reading every account has to fold the same
  // conversation back together. SQLite fills a bare column from whichever row matched the
  // MAX in the same select, which is how subject, snippet and senders come from the latest
  // message rather than an arbitrary one.
  const rows = owner === null
    ? await tagged(db(), `
        SELECT thread_id, subject, MIN(first_at) AS first_at, MAX(latest_at) AS latest_at, latest_id,
          SUM(count) AS count, SUM(unread_count) AS unread_count, SUM(starred_count) AS starred_count,
          SUM(inbox_count) AS inbox_count, SUM(archived_count) AS archived_count,
          SUM(trashed_count) AS trashed_count, SUM(spam_count) AS spam_count, SUM(attach_count) AS attach_count,
          senders, snippet, labels, snoozed_until, addressed, risk
        FROM mail_threads
        GROUP BY thread_id
        HAVING ${predicate}${cursorClause ? ` AND ${cursorClause}` : ''}
        ORDER BY latest_at DESC, thread_id DESC LIMIT ?`,
        [...folderArgs, ...cursorArgs, limit])
    : await tagged(db(), `
        SELECT thread_id, subject, first_at, latest_at, latest_id, count, unread_count, starred_count,
          inbox_count, archived_count, trashed_count, spam_count, attach_count, senders, snippet, labels, snoozed_until, addressed, risk
        FROM mail_threads WHERE owner = ? AND ${predicate}
          ${cursorClause ? `AND ${cursorClause}` : ''}
        ORDER BY latest_at DESC, thread_id DESC LIMIT ?`,
        [owner, ...folderArgs, ...cursorArgs, limit])
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
    spamCount: Number(row.spam_count ?? 0),
    attachCount: Number(row.attach_count ?? 0),
    senders: parseJson<string[]>(row.senders, []),
    snippet: String(row.snippet ?? ''),
    labels: parseJson<string[]>(row.labels, []),
    snoozedUntil: row.snoozed_until == null ? null : String(row.snoozed_until),
    addressed: (['direct', 'copied', 'other'].includes(String(row.addressed)) ? String(row.addressed) : 'direct') as Addressed,
    risk: (['clean', 'suspicious', 'spam', 'virus'].includes(String(row.risk)) ? String(row.risk) : 'clean') as Risk,
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
    INSERT INTO mail_inbox (id, from_addr, to_addrs, cc, bcc, reply_to, subject, html, body_text, headers, received_at, read, attachments, owner, snippet, thread_meta, attach_meta, addressed, risk, risk_reasons, spam)
    VALUES (${email.id}, ${email.from}, ${JSON.stringify(email.to)}, ${JSON.stringify(email.cc)}, ${JSON.stringify(email.bcc)}, ${JSON.stringify(email.replyTo)}, ${email.subject}, ${email.html}, ${email.text}, ${JSON.stringify(email.headers)}, ${email.receivedAt}, ${email.read}, ${JSON.stringify(email.attachments)}, ${email.owner ?? null}, ${listSnippet(email.text)}, ${threadMeta(email.headers)}, ${attachMeta(email.attachments)}, ${classifyAddressed(email.owner, email.to, email.cc)}, ${email.risk ?? 'clean'}, ${JSON.stringify(email.riskReasons ?? [])}, ${email.spam ? 1 : 0})
    ON CONFLICT (id) DO NOTHING`
  await threadMessage({ id: email.id, owner: email.owner ?? null, subject: email.subject, receivedAt: email.receivedAt })
  await invalidateCounts(email.owner)
}

/**
 * Fill in what a hollow row is missing, for messages stored before the body could be
 * fetched. Only ever writes content that is absent — read, starred, archived, trashed,
 * labels and owner are the reader's, not the repair's, and a row that already has a body
 * is left exactly as it is.
 */
export async function rejudgeStored(options: { before?: string; limit?: number } = {}): Promise<{
  scanned: number
  changed: number
  quarantined: number
  cursor: string | null
}> {
  await ensureMailSchema()
  const sql = db()
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500)
  const before = options.before ?? '9999-12-31'
  const rows = await sql`
    SELECT id, owner, from_addr, reply_to, subject, body_text, headers, received_at,
           read, starred, archived, trashed, risk, spam
    FROM mail_inbox
    WHERE received_at < ${before}
    ORDER BY received_at DESC
    LIMIT ${limit}`

  const result = { scanned: rows.length, changed: 0, quarantined: 0, cursor: null as string | null }
  if (rows.length === 0) return result
  result.cursor = String(rows[rows.length - 1].received_at ?? '')

  const standings = new Map<string, SenderStanding>()
  const touchedOwners = new Set<string>()
  for (const row of rows) {
    const owner = String(row.owner ?? '')
    const senderDomain = senderDomainOf(String(row.from_addr ?? ''))
    const key = `${owner.toLowerCase()}\u0000${senderDomain}`
    let standing = standings.get(key)
    if (!standing) {
      standing = await senderStanding(owner, senderDomain)
      standings.set(key, standing)
    }

    const headers = parseJson<Record<string, unknown>>(row.headers, {})
    const authHeader = headerString(headers, 'authentication-results').toLowerCase()
    const mechanism = (name: string) => authHeader.match(new RegExp(`${name}=(\\w+)`))?.[1] ?? null
    const verdict = judgeMessage({
      spam: null,
      virus: null,
      spf: mechanism('spf'),
      dkim: mechanism('dkim'),
      dmarc: mechanism('dmarc'),
      from: String(row.from_addr ?? ''),
      replyTo: parseJson<string[]>(row.reply_to, []),
      subject: String(row.subject ?? ''),
      text: row.body_text == null ? null : String(row.body_text),
    }, standing)

    // A message the reader has already read, starred, filed or binned stays exactly where
    // they put it — back-fill may label it, never move it out from under them.
    const untouched = !Number(row.read) && !Number(row.starred) && !Number(row.archived) && !Number(row.trashed)
    const quarantine = verdict.quarantine && untouched
    if (String(row.risk ?? 'clean') === verdict.risk && Boolean(Number(row.spam)) === quarantine) {
      // The verdict is unchanged, but the conversation summary the list reads from may still
      // predate it — worth one refresh for the few that carry a warning.
      if (verdict.risk !== 'clean') await rethreadAfterChange(String(row.id))
      continue
    }

    await sql`
      UPDATE mail_inbox
      SET risk = ${verdict.risk}, risk_reasons = ${JSON.stringify(verdict.reasons)}, spam = ${quarantine ? 1 : 0}
      WHERE id = ${String(row.id)}`
    await rethreadAfterChange(String(row.id))
    result.changed += 1
    if (quarantine) result.quarantined += 1
    if (owner) touchedOwners.add(owner)
  }

  for (const owner of touchedOwners) await invalidateCounts(owner)
  return result
}

export async function repairInbound(
  email: Pick<InboundEmail, 'id' | 'html' | 'text' | 'headers' | 'attachments'>,
): Promise<boolean> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    UPDATE mail_inbox SET
      html = CASE WHEN coalesce(html, '') = '' THEN ${email.html} ELSE html END,
      body_text = CASE WHEN coalesce(body_text, '') = '' THEN ${email.text} ELSE body_text END,
      headers = CASE WHEN coalesce(headers, '') IN ('', '{}') THEN ${JSON.stringify(email.headers)} ELSE headers END,
      attachments = CASE WHEN coalesce(attachments, '') IN ('', '[]') THEN ${JSON.stringify(email.attachments)} ELSE attachments END,
      attach_meta = CASE WHEN coalesce(attach_meta, '') IN ('', '[]') THEN ${attachMeta(email.attachments)} ELSE attach_meta END,
      snippet = CASE WHEN coalesce(snippet, '') = '' THEN ${listSnippet(email.text)} ELSE snippet END,
      thread_meta = CASE WHEN coalesce(thread_meta, '') IN ('', '{}') THEN ${threadMeta(email.headers)} ELSE thread_meta END
    WHERE id = ${email.id}
    RETURNING id`
  return rows.length > 0
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
      // Without this the list forgets the file was a shared link, and the tile it draws
      // offers neither a preview nor anywhere to go.
      ...(entry.shareId ? { shareId: entry.shareId } : {}),
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
  const moved = await sql`SELECT to_addrs, cc FROM mail_inbox WHERE id = ${id}`
  const nowAddressed = classifyAddressed(owner, parseArray(moved[0]?.to_addrs), parseArray(moved[0]?.cc))
  // A message that was a copy in one mailbox can be direct mail in another.
  await sql`UPDATE mail_inbox SET owner = ${owner ? owner.toLowerCase() : null}, thread_id = NULL, addressed = ${nowAddressed} WHERE id = ${id}`
  // Both sides change: the mailbox it left and the one it arrived in.
  await invalidateCounts(before[0]?.owner == null ? null : String(before[0].owner))
  await invalidateCounts(owner)
  await rethreadAfterChange(id, before[0]?.owner == null ? null : String(before[0].owner), before[0]?.thread_id == null ? null : String(before[0].thread_id))
}

export async function markInboundRead(id: string): Promise<void> {
  const sql = db()
  await sql`UPDATE mail_inbox SET read = 1 WHERE id = ${id}`
  const owned = await sql`SELECT owner FROM mail_inbox WHERE id = ${id}`
  await invalidateCounts(owned[0]?.owner == null ? null : String(owned[0].owner))
  await rethreadAfterChange(id)
}

/**
 * Moves a message in or out of quarantine and remembers the decision. This is the loop:
 * what the reader does with a sender's mail decides how the next one is treated, so the
 * same message can be spam in one mailbox and ordinary correspondence in another.
 */
export async function setInboundSpam(id: string, spam: boolean): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT owner, from_addr FROM mail_inbox WHERE id = ${id}`
  const row = rows[0]
  // A reader who says "not spam" has overruled the judgement, so the warning goes with the
  // quarantine — leaving the badge on would argue with them every time they open it.
  await (spam
    ? sql`UPDATE mail_inbox SET spam = 1, archived = 0, trashed = 0 WHERE id = ${id}`
    : sql`UPDATE mail_inbox SET spam = 0, archived = 0, trashed = 0, risk = 'clean', risk_reasons = '[]' WHERE id = ${id}`)
  if (row?.owner) {
    await noteSender(String(row.owner), senderDomainOf(String(row.from_addr ?? '')), spam ? 'marked_spam' : 'replied')
      .catch(() => {})
  }
  await invalidateCounts(row?.owner == null ? null : String(row.owner))
  await rethreadAfterChange(id)
}

export async function setInboundFlags(id: string, flags: InboundFlags): Promise<void> {
  const sql = db()
  if (flags.read !== undefined) await sql`UPDATE mail_inbox SET read = ${flags.read} WHERE id = ${id}`
  if (flags.starred !== undefined) await sql`UPDATE mail_inbox SET starred = ${flags.starred} WHERE id = ${id}`
  if (flags.archived !== undefined) await sql`UPDATE mail_inbox SET archived = ${flags.archived} WHERE id = ${id}`
  if (flags.trashed !== undefined) await sql`UPDATE mail_inbox SET trashed = ${flags.trashed} WHERE id = ${id}`
  const owned = await sql`SELECT owner, from_addr FROM mail_inbox WHERE id = ${id}`
  // Binning a sender's mail counts against them; it is the commonest way a reader says
  // "not this one" without ever pressing a button marked spam.
  if (flags.trashed === true && owned[0]?.owner) {
    await noteSender(String(owned[0].owner), senderDomainOf(String(owned[0].from_addr ?? '')), 'trashed').catch(() => {})
  }
  await invalidateCounts(owned[0]?.owner == null ? null : String(owned[0].owner))
  await rethreadAfterChange(id)
}

/**
 * Flags every message in one conversation. The list shows a row per thread, and a client
 * that has not loaded that thread's messages cannot name them — which is why archiving a
 * row whose mail sat below the loaded page quietly did nothing.
 */
export async function setInboundFlagsForThread(
  ownerRaw: string,
  threadId: string,
  flags: InboundFlags,
): Promise<string[]> {
  await ensureMailSchema()
  const sql = db()
  const owner = ownerRaw.toLowerCase()
  const rows = await sql`
    SELECT id FROM mail_inbox WHERE lower(owner) = ${owner} AND thread_id = ${threadId}`
  const ids = rows.map(row => String(row.id))
  for (const id of ids) await setInboundFlags(id, flags)
  return ids
}

/**
 * Snooze or wake a conversation. Snooze is a property of the conversation rather than of
 * one message in it: the list shows a row per thread, and half a thread disappearing would
 * be a puzzle rather than a feature. `until` of null wakes it immediately.
 */
export async function setThreadSnooze(
  ownerRaw: string,
  threadId: string,
  until: string | null,
): Promise<number> {
  await ensureMailSchema()
  const sql = db()
  const owner = ownerRaw.toLowerCase()
  const rows = await sql`
    SELECT id FROM mail_inbox WHERE lower(owner) = ${owner} AND thread_id = ${threadId}`
  for (const row of rows) {
    await sql`UPDATE mail_inbox SET snoozed_until = ${until} WHERE id = ${String(row.id)}`
  }
  await sql`
    UPDATE mail_threads SET snoozed_until = ${until}
    WHERE owner = ${owner} AND thread_id = ${threadId}`
  await invalidateCounts(owner)
  return rows.length
}

/** Which of these message ids the mailbox already holds. */
export async function inboundExists(ids: string[]): Promise<Set<string>> {
  await ensureMailSchema()
  const found = new Set<string>()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    if (!chunk.length) break
    const rows = await tagged(db(), `SELECT id FROM mail_inbox WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk)
    for (const row of rows) found.add(String(row.id))
  }
  return found
}

export async function setInboundLabels(id: string, labels: string[]): Promise<void> {
  const sql = db()
  await sql`UPDATE mail_inbox SET labels = ${JSON.stringify(labels)} WHERE id = ${id}`
  const owned = await sql`SELECT owner FROM mail_inbox WHERE id = ${id}`
  await invalidateCounts(owned[0]?.owner == null ? null : String(owned[0].owner))
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
  /** Outside address that can receive a reset link. Only usable once proven. */
  recoveryEmail: string | null
  recoveryVerified: boolean
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
    recoveryEmail: (row.recovery_email as string) ?? null,
    recoveryVerified: Boolean(Number(row.recovery_verified ?? 0)),
  }
}

export async function listAccounts(): Promise<MailAccount[]> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT email, name, address, role, status, invited_by, created_at, recovery_email, recovery_verified, (password_hash IS NOT NULL) AS has_password FROM mail_accounts ORDER BY created_at ASC`
  return rows.map(mapAccount)
}

export async function getAccount(email: string): Promise<MailAccount | null> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT email, name, address, role, status, invited_by, created_at, recovery_email, recovery_verified, (password_hash IS NOT NULL) AS has_password FROM mail_accounts WHERE email = ${email.trim().toLowerCase()}`
  return rows[0] ? mapAccount(rows[0]) : null
}

export async function getAccountByAddress(address: string): Promise<MailAccount | null> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`SELECT email, name, address, role, status, invited_by, created_at, recovery_email, recovery_verified, (password_hash IS NOT NULL) AS has_password FROM mail_accounts WHERE lower(address) = ${address.trim().toLowerCase()}`
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

/** Record a recovery address as claimed but unproven. Re-saving the same one re-arms it. */
export async function setRecoveryEmail(email: string, recovery: string | null): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  const normalized = recovery ? recovery.trim().toLowerCase() : null
  await sql`
    UPDATE mail_accounts SET recovery_email = ${normalized}, recovery_verified = 0
    WHERE email = ${email.trim().toLowerCase()}`
}

/** Prove the address: only the one currently on the account, so a stale link cannot land. */
export async function markRecoveryVerified(email: string, recovery: string): Promise<boolean> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    UPDATE mail_accounts SET recovery_verified = 1
    WHERE email = ${email.trim().toLowerCase()} AND lower(recovery_email) = ${recovery.trim().toLowerCase()}
    RETURNING email`
  return rows.length > 0
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
  /** How many files the list should raise a paperclip for, counted the way the inbox counts. */
  attachmentCount?: number
  /** Sent by the app itself — an invite, a reset, an auto-reply — rather than by a person. */
  isAuto?: boolean
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

/**
 * Which columns a search term can narrow in SQL. The precise decision is still made by
 * matchesQuery on the rows that come back; this only keeps the scan from reading every
 * body in the archive. A term it cannot express leaves its group unnarrowed rather than
 * narrowing it wrongly.
 */
const SENT_SEARCH_COLUMNS: Record<string, string> = {
  to: 's.to_addrs',
  cc: 's.cc',
  bcc: 's.bcc',
  from: 's.from_addr',
  subject: 's.subject',
  // Must match the substr the exact matcher is handed, or a deep hit passes SQL then drops.
  body: "substr(coalesce(s.body_text, ''), 1, 4000)",
}

/** A LIKE pattern for a literal term: its own wildcards are made literal too. */
function likeLiteral(value: string): string {
  return `%${value.replace(/[\\%_]/g, char => `\\${char}`)}%`
}

function sentSearchPrefilter(query: ParsedQuery): { clauses: string[]; args: unknown[] } {
  const clauses: string[] = []
  const args: unknown[] = []
  for (const group of query.groups) {
    const ors: string[] = []
    const groupArgs: unknown[] = []
    let expressible = true
    for (const term of group) {
      // SQLite's lower() folds ASCII only; leave such terms to the exact matcher.
      if (/[^\x00-\x7f]/.test(term.value)) { expressible = false; break }
      const column = term.field ? SENT_SEARCH_COLUMNS[term.field] : null
      if (column) {
        ors.push(`lower(coalesce(${column}, '')) ${term.negated ? 'NOT LIKE' : 'LIKE'} ? ESCAPE '\\'`)
        groupArgs.push(likeLiteral(term.value))
        continue
      }
      if (!term.field) {
        if (term.negated) { expressible = false; break }
        const columns = ['s.to_addrs', 's.cc', 's.from_addr', 's.subject', "substr(coalesce(s.body_text, ''), 1, 4000)"]
        ors.push(`(${columns.map(col => `lower(coalesce(${col}, '')) LIKE ? ESCAPE '\\'`).join(' OR ')})`)
        groupArgs.push(...columns.map(() => likeLiteral(term.value)))
        continue
      }
      if (term.field === 'before' || term.field === 'after') {
        const at = Date.parse(term.value)
        if (Number.isNaN(at)) { expressible = false; break }
        ors.push(`s.created_at ${term.field === 'before' ? '<' : '>'} ?`)
        groupArgs.push(new Date(at).toISOString())
        continue
      }
      if (term.field === 'older_than' || term.field === 'newer_than') {
        const span = duration(term.value)
        if (span == null) { expressible = false; break }
        ors.push(`s.created_at ${term.field === 'older_than' ? '<' : '>'} ?`)
        groupArgs.push(new Date(Date.now() - span).toISOString())
        continue
      }
      expressible = false
      break
    }
    if (expressible && ors.length) {
      clauses.push(`(${ors.join(' OR ')})`)
      args.push(...groupArgs)
    }
  }
  return { clauses, args }
}

/**
 * The sent archive for one mailbox, newest first. Unscoped, the newest 500 rows of the
 * whole table were read and then filtered by owner, so each person saw their share of the
 * company's last 500 sends — a quiet mailbox could see a dozen. The owner is matched on
 * the assignment in mail_sent_meta, else on the sender address; the caller still applies
 * its exact attribution on top.
 *
 * With a query, the search runs here over the whole archive instead of over whatever the
 * client happened to have loaded, and returns the body text the matcher needs.
 */
export async function readSentArchive(options: {
  ownerAddress?: string | null
  sharedAddress?: string | null
  query?: ParsedQuery | null
  limit?: number
  includeAuto?: boolean
} = {}): Promise<SentMessage[]> {
  await ensureMailSchema()
  const sql = db()
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000)
  const where: string[] = options.includeAuto ? [] : ['coalesce(m.is_auto, 0) = 0']
  const args: unknown[] = []

  const owner = options.ownerAddress?.trim().toLowerCase()
  if (owner && owner !== options.sharedAddress?.toLowerCase()) {
    where.push(`(lower(m.owner) = ? OR ((m.owner IS NULL OR m.owner = '') AND lower(s.from_addr) LIKE ? ESCAPE '\\'))`)
    args.push(owner, likeLiteral(owner))
  }
  if (options.query && !options.query.isEmpty) {
    const prefilter = sentSearchPrefilter(options.query)
    where.push(...prefilter.clauses)
    args.push(...prefilter.args)
  }

  // The list never shows a body, and 500 bodies is tens of megabytes — the Sent folder
  // took half a minute to open once an archive had been imported. A search needs some of
  // it to decide bare terms, so it gets the first few thousand characters and no more.
  const textColumn = options.query ? "substr(coalesce(s.body_text, ''), 1, 4000)" : 'NULL'
  const rows = await tagged(
    sql,
    `SELECT s.id, s.from_addr, s.to_addrs, s.cc, s.bcc, s.reply_to, s.subject, s.created_at, s.last_event,
            json_array_length(CASE WHEN json_valid(s.attachments) THEN s.attachments ELSE '[]' END) AS attach_count,
            coalesce(m.is_auto, 0) AS is_auto,
            ${textColumn} AS text
     FROM mail_sent s LEFT JOIN mail_sent_meta m ON m.email_id = s.id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY s.created_at DESC LIMIT ?`,
    [...args, limit],
  )
  return rows.map(row => ({
    id: String(row.id),
    from: (row.from_addr as string) ?? '',
    to: parseArray(row.to_addrs),
    cc: parseArray(row.cc),
    bcc: parseArray(row.bcc),
    replyTo: parseArray(row.reply_to),
    subject: (row.subject as string) ?? '',
    html: null,
    text: row.text == null ? null : String(row.text),
    createdAt: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
    lastEvent: (row.last_event as string) ?? null,
    attachmentCount: Number(row.attach_count ?? 0),
    isAuto: Boolean(Number(row.is_auto ?? 0)),
  }))
}

// ── Sent-mail attribution (owner + automated flag + thread link) ─
export type SentMeta = { owner: string | null; isAuto: boolean; inReplyTo: string | null }

/** Writing back to somebody is the clearest statement that their mail is wanted. */
export async function noteReplyTo(owner: string | null, address: string): Promise<void> {
  await noteSender(owner, senderDomainOf(address), 'replied').catch(() => {})
}

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
  // The sql tag binds every interpolation as a parameter; a spliced WHERE became `... ?`,
  // a syntax error the callers swallowed, so every lookup came back empty.
  const out: Record<string, SentMeta> = {}
  const collect = (rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      out[String(row.email_id)] = {
        owner: (row.owner as string) ?? null,
        isAuto: Boolean(row.is_auto),
        inReplyTo: (row.in_reply_to as string) ?? null,
      }
    }
  }
  if (!emailIds) {
    collect(await sql`SELECT email_id, owner, is_auto, in_reply_to FROM mail_sent_meta`)
    return out
  }
  for (let i = 0; i < emailIds.length; i += 200) {
    const chunk = emailIds.slice(i, i + 200)
    if (!chunk.length) break
    collect(
      await tagged(
        sql,
        `SELECT email_id, owner, is_auto, in_reply_to FROM mail_sent_meta WHERE email_id IN (${chunk.map(() => '?').join(',')})`,
        chunk,
      ),
    )
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

export async function createResetToken(
  email: string,
  token: string,
  expires: number,
  purpose: 'reset' | 'verify-recovery' = 'reset',
): Promise<void> {
  await ensureMailSchema()
  const sql = db()
  await sql`DELETE FROM mail_reset_tokens WHERE expires_at < ${nowIso()}`
  await sql`
    INSERT INTO mail_reset_tokens (token, email, expires_at, purpose)
    VALUES (${token}, ${email.toLowerCase()}, ${new Date(expires).toISOString()}, ${purpose})`
}

/** Spend a non-reset token, returning the address it was issued for. */
export async function consumeToken(token: string, purpose: 'verify-recovery'): Promise<string | null> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    DELETE FROM mail_reset_tokens
    WHERE token = ${token} AND purpose = ${purpose} AND expires_at > ${nowIso()}
    RETURNING email`
  return rows[0]?.email ? String(rows[0].email) : null
}

/**
 * The address a live token belongs to, without consuming it, so the new password can be
 * checked against the account's own policy before the single-use token is spent.
 */
export async function resetTokenEmail(token: string): Promise<string | null> {
  await ensureMailSchema()
  const sql = db()
  const rows = await sql`
    SELECT email FROM mail_reset_tokens
    WHERE token = ${token} AND coalesce(purpose, 'reset') = 'reset' AND expires_at > ${nowIso()}`
  const email = rows[0]?.email
  return email ? String(email) : null
}

/** Atomically consume a valid token and set the new password. Single-use, no race window. */
export async function resetPasswordWithToken(token: string, passwordHash: string): Promise<string | null> {
  await ensureMailSchema()
  const sql = db()
  const consumed = await sql`
    DELETE FROM mail_reset_tokens
    WHERE token = ${token} AND coalesce(purpose, 'reset') = 'reset' AND expires_at > ${nowIso()}
    RETURNING email`
  const email = consumed[0]?.email
  if (!email) return null
  await sql`
    INSERT INTO mail_accounts (email, password_hash, status, created_at) VALUES (${String(email)}, ${passwordHash}, 'active', ${nowIso()})
    ON CONFLICT (email) DO UPDATE SET
      password_hash = excluded.password_hash,
      status = 'active',
      password_is_default = 0`
  // Any other link still outstanding for this address is now stale — and one of them
  // may be the reason the password is being changed.
  await sql`DELETE FROM mail_reset_tokens WHERE email = ${String(email)}`
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

/**
 * "busy" is the one that matters: an attempt is still inside its lease. The caller must
 * answer the provider with a failure, not a duplicate — five stranded deliveries on the
 * old host came from a process the platform killed mid-way, whose 5s and 5m retries were
 * each told "already handled" and so the provider never tried again.
 */
export type WebhookClaim = 'claimed' | 'done' | 'busy'

export async function claimWebhookEvent(id: string): Promise<WebhookClaim> {
  if (!id) return 'claimed'
  await ensureMailSchema()

  const inserted = await sqlRaw(
    `INSERT INTO mail_webhook_events (id, handled_at, status) VALUES (?, ?, 'working')
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, nowIso()],
  )
  if (inserted.length > 0) return 'claimed'

  const existing = await sqlRaw('SELECT handled_at, status FROM mail_webhook_events WHERE id = ?', [id])
  const row = existing[0]
  if (!row) return 'claimed'
  if (String(row.status) === 'done') return 'done'

  const startedAt = new Date(String(row.handled_at)).getTime()
  if (Number.isFinite(startedAt) && Date.now() - startedAt < CLAIM_LEASE_MS) return 'busy'

  // The attempt holding this never finished and its lease has run out. Take it over.
  await sqlRaw('UPDATE mail_webhook_events SET handled_at = ? WHERE id = ?', [nowIso(), id])
  return 'claimed'
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
        const base = (process.env.RESEND_BASE_URL ?? '').trim().replace(/\/+$/, '') || 'https://api.resend.com'
        const listing = await fetch(`${base}/emails/receiving/${encodeURIComponent(id)}/attachments`, {
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
            if (!source && !entry.content) return meta
            let bytes: Buffer
            if (entry.content) bytes = Buffer.from(String(entry.content), 'base64')
            else {
              const binary = await fetch(source)
              if (!binary.ok) return meta
              bytes = Buffer.from(await binary.arrayBuffer())
            }
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
