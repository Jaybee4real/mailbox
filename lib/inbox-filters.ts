export type InboxFilterKind = 'senderPrefix' | 'senderDomain' | 'subjectPrefix' | 'subjectContains' | 'messagePrefix'
export type InboxFilter = { kind: InboxFilterKind; value: string }

export const INBOX_FILTER_KINDS: Array<{ kind: InboxFilterKind; label: string; placeholder: string }> = [
  { kind: 'senderPrefix', label: 'Sender starts with', placeholder: 'dmarcreport' },
  { kind: 'senderDomain', label: 'Sender domain', placeholder: 'example.com' },
  { kind: 'subjectPrefix', label: 'Subject starts with', placeholder: 'Report Domain:' },
  { kind: 'subjectContains', label: 'Subject contains', placeholder: 'newsletter' },
  { kind: 'messagePrefix', label: 'Message starts with', placeholder: 'This is an automated' },
]

export const DEFAULT_INBOX_FILTERS: InboxFilter[] = [{ kind: 'senderPrefix', value: 'dmarcreport' }]

const MAX_FILTERS = 40
const MAX_VALUE = 200
const SENDER_KINDS = new Set<InboxFilterKind>(['senderPrefix', 'senderDomain'])

/** A person who never touched the list gets the defaults; one who emptied it gets none. */
export function normalizeInboxFilters(raw: unknown): InboxFilter[] {
  if (!Array.isArray(raw)) return DEFAULT_INBOX_FILTERS
  const seen = new Set<string>()
  const filters: InboxFilter[] = []
  for (const entry of raw) {
    const kind = (entry as InboxFilter)?.kind
    if (!INBOX_FILTER_KINDS.some(option => option.kind === kind)) continue
    let value = String((entry as InboxFilter).value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE)
    if (SENDER_KINDS.has(kind)) value = value.toLowerCase().replace(/^@/, '')
    const key = `${kind}:${value.toLowerCase()}`
    if (!value || seen.has(key)) continue
    seen.add(key)
    filters.push({ kind, value })
    if (filters.length === MAX_FILTERS) break
  }
  return filters
}

const likeEscape = (value: string) => value.replace(/[\\%_]/g, match => `\\${match}`)

function senderAddress(raw: string): string {
  const angled = raw.match(/<([^>]*)>?/)
  return (angled ? angled[1] : raw).trim().toLowerCase()
}

const ADDRESS_SQL = "lower(trim(rtrim(CASE WHEN instr(value, '<') > 0 THEN substr(value, instr(value, '<') + 1) ELSE value END, '> ')))"
const SNIPPET_SQL = "ltrim(coalesce(t.snippet, ''), ' ' || char(9, 10, 13))"

/**
 * The rules as one SQL condition over a mail_threads row aliased `t`. Sender rules hold only
 * when every sender in the conversation matches, so a person replying into a filtered
 * thread brings it back; subject and message rules read the latest message.
 */
export function inboxFiltersSql(filters: InboxFilter[]): { sql: string; args: string[] } | null {
  if (!filters.length) return null
  const senderRules: string[] = []
  const senderArgs: string[] = []
  const rules: string[] = []
  const args: string[] = []
  for (const filter of filters) {
    const value = likeEscape(filter.value)
    if (filter.kind === 'senderPrefix') {
      senderRules.push(`${ADDRESS_SQL} LIKE ? ESCAPE '\\'`)
      senderArgs.push(`${value.toLowerCase()}%`)
    } else if (filter.kind === 'senderDomain') {
      senderRules.push(`(${ADDRESS_SQL} LIKE ? ESCAPE '\\' OR ${ADDRESS_SQL} LIKE ? ESCAPE '\\')`)
      senderArgs.push(`%@${value.toLowerCase()}`, `%.${value.toLowerCase()}`)
    } else if (filter.kind === 'subjectPrefix') {
      rules.push(`coalesce(t.subject, '') LIKE ? ESCAPE '\\'`)
      args.push(`${value}%`)
    } else if (filter.kind === 'subjectContains') {
      rules.push(`coalesce(t.subject, '') LIKE ? ESCAPE '\\'`)
      args.push(`%${value}%`)
    } else {
      rules.push(`${SNIPPET_SQL} LIKE ? ESCAPE '\\'`)
      args.push(`${value}%`)
    }
  }
  const parts = [...rules]
  if (senderRules.length) {
    parts.unshift(
      `(json_array_length(coalesce(t.senders, '[]')) > 0 AND NOT EXISTS (SELECT 1 FROM json_each(coalesce(t.senders, '[]')) WHERE NOT (${senderRules.join(' OR ')})))`,
    )
  }
  return { sql: `(${parts.join(' OR ')})`, args: [...senderArgs, ...args] }
}

/** The same rules for one message, for the paths that never reach SQL — a push, say. */
export function matchesInboxFilters(
  filters: InboxFilter[],
  message: { senders: string[]; subject: string | null | undefined; text: string | null | undefined },
): boolean {
  const addresses = message.senders.filter(Boolean).map(senderAddress)
  const subject = (message.subject ?? '').toLowerCase()
  const text = (message.text ?? '').trimStart().toLowerCase()
  const senderMatches = (address: string) =>
    filters.some(filter => {
      if (filter.kind === 'senderPrefix') return address.startsWith(filter.value.toLowerCase())
      if (filter.kind === 'senderDomain') {
        const domain = filter.value.toLowerCase()
        return address.endsWith(`@${domain}`) || address.endsWith(`.${domain}`)
      }
      return false
    })
  if (filters.some(filter => SENDER_KINDS.has(filter.kind)) && addresses.length && addresses.every(senderMatches)) return true
  return filters.some(filter => {
    const value = filter.value.toLowerCase()
    if (filter.kind === 'subjectPrefix') return subject.startsWith(value)
    if (filter.kind === 'subjectContains') return subject.includes(value)
    if (filter.kind === 'messagePrefix') return text.startsWith(value)
    return false
  })
}
