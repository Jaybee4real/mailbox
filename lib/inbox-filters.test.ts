import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_INBOX_FILTERS, inboxFiltersSql, matchesInboxFilters, normalizeInboxFilters, prioritySenders, prioritySql, type InboxFilter } from './inbox-filters.ts'

assert.deepEqual(normalizeInboxFilters(undefined), DEFAULT_INBOX_FILTERS, 'untouched settings get the defaults')
assert.deepEqual(normalizeInboxFilters([]), [], 'an emptied list stays empty')
assert.deepEqual(
  normalizeInboxFilters([
    { kind: 'senderDomain', value: ' @Example.COM ' },
    { kind: 'senderDomain', value: 'example.com' },
    { kind: 'bogus', value: 'x' },
    { kind: 'subjectPrefix', value: '   ' },
  ]),
  [{ kind: 'senderDomain', value: 'example.com' }],
  'sender values are lowercased, duplicates and junk dropped',
)

const threads = [
  { id: 'dmarc', senders: ['DMARC <dmarcreport@microsoft.com>'], subject: '[Preview] Report Domain: example.com', snippet: 'This is a DMARC report' },
  { id: 'dmarc-joined', senders: ['dmarcreport@microsoft.com', 'Ada <ada@example.org>'], subject: 'Re: report', snippet: 'Thanks' },
  { id: 'newsletter', senders: ['news@mail.example.net'], subject: 'Weekly: what shipped', snippet: '\n  Unsubscribe any time' },
  { id: 'person', senders: ['Ada <ada@example.org>'], subject: 'Lunch 50% off?', snippet: 'Hi' },
]

const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE mail_threads (thread_id TEXT, senders TEXT, subject TEXT, snippet TEXT)')
const insert = db.prepare('INSERT INTO mail_threads VALUES (?, ?, ?, ?)')
for (const thread of threads) insert.run(thread.id, JSON.stringify(thread.senders), thread.subject, thread.snippet)

const viaSql = (filters: InboxFilter[]) => {
  const clause = inboxFiltersSql(filters)
  if (!clause) return []
  return db.prepare(`SELECT thread_id FROM mail_threads t WHERE ${clause.sql} ORDER BY thread_id`).all(...clause.args).map(row => String(row.thread_id))
}
const viaJs = (filters: InboxFilter[]) =>
  threads.filter(thread => matchesInboxFilters(filters, { senders: thread.senders, subject: thread.subject, text: thread.snippet })).map(thread => thread.id).sort()

const cases: Array<[InboxFilter[], string[]]> = [
  [DEFAULT_INBOX_FILTERS, ['dmarc']],
  [[{ kind: 'senderDomain', value: 'example.net' }], ['newsletter']],
  [[{ kind: 'senderDomain', value: 'microsoft.com' }], ['dmarc']],
  [[{ kind: 'subjectPrefix', value: 'weekly:' }], ['newsletter']],
  [[{ kind: 'subjectContains', value: '50%' }], ['person']],
  [[{ kind: 'subjectContains', value: '0%' }], ['person']],
  [[{ kind: 'messagePrefix', value: 'unsubscribe' }], ['newsletter']],
  [[{ kind: 'senderPrefix', value: 'dmarcreport' }, { kind: 'senderPrefix', value: 'ada' }], ['dmarc', 'dmarc-joined', 'person']],
]
for (const [filters, expected] of cases) {
  assert.deepEqual(viaSql(filters), expected, `sql ${JSON.stringify(filters)}`)
  assert.deepEqual(viaJs(filters), expected, `js ${JSON.stringify(filters)}`)
}
assert.equal(inboxFiltersSql([]), null)

db.exec('CREATE TABLE mail_inbox (id TEXT, owner TEXT, thread_id TEXT, from_addr TEXT, read INTEGER, archived INTEGER DEFAULT 0, trashed INTEGER DEFAULT 0, spam INTEGER DEFAULT 0)')
const message = db.prepare('INSERT INTO mail_inbox (id, owner, thread_id, from_addr, read) VALUES (?, ?, ?, ?, ?)')
message.run('m1', 'ada@us.test', 'enquiry', 'Website <no-reply@site.test>', 0)
message.run('m2', 'ada@us.test', 'long-client-thread', 'Support <hello@vendor.test>', 1)
message.run('m3', 'ada@us.test', 'long-client-thread', 'Client <client@example.org>', 0)
message.run('m4', 'bo@us.test', 'enquiry', 'Website <no-reply@site.test>', 1)
message.run('m5', 'ada@us.test', 'notice', 'hello@mail.vendor.test', 0)
db.exec("CREATE TABLE threads (owner TEXT, thread_id TEXT)")
for (const [owner, thread] of [['ada@us.test', 'enquiry'], ['ada@us.test', 'long-client-thread'], ['bo@us.test', 'enquiry'], ['ada@us.test', 'notice']]) {
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(owner, thread)
}
const priority = (raw: string) => {
  const clause = prioritySql(prioritySenders(raw), 't.owner')
  if (!clause) return []
  return db.prepare(`SELECT owner || ':' || thread_id AS key FROM threads t WHERE ${clause.sql} ORDER BY key`).all(...clause.args).map(row => String(row.key))
}
assert.deepEqual(priority(''), [], 'no priority senders, no priority')
assert.deepEqual(priority(' NO-REPLY@site.test '), ['ada@us.test:enquiry'], 'an unread message from the sender pins it, for its own owner only')
assert.deepEqual(priority('hello@vendor.test'), [], 'one read message from the sender in a client thread does not pin it')
assert.deepEqual(priority('@vendor.test'), ['ada@us.test:notice'], 'a domain covers its subdomains, and still needs an unread message')

console.log('inbox-filters: ok')
