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

const priority = (raw: string) => {
  const clause = prioritySql(prioritySenders(raw))
  if (!clause) return []
  return db.prepare(`SELECT thread_id FROM mail_threads t WHERE ${clause.sql} ORDER BY thread_id`).all(...clause.args).map(row => String(row.thread_id))
}
assert.deepEqual(priority(''), [], 'no priority senders, no priority')
assert.deepEqual(priority(' ADA@example.org '), ['dmarc-joined', 'person'], 'an address matches any sender in the conversation')
assert.deepEqual(priority('@example.net,@microsoft.com'), ['dmarc', 'dmarc-joined', 'newsletter'], 'a domain matches its own senders')
assert.deepEqual(priority('@mail.example'), [], 'a domain is matched at its end, not inside')

console.log('inbox-filters: ok')
