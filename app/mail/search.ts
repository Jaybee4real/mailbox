/**
 * Gmail-style query parsing for the mail list.
 *
 * A query is an AND of groups; a group is an OR of terms. `-` negates a term, quotes keep a
 * phrase together, and `OR` (or `|`) joins the previous term with the next into one group.
 * Anything without a `field:` prefix is free text and is matched against every searchable
 * part of the message, body included.
 */

export type SearchDoc = {
  from: string
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  filenames: string
  date: number
  /** null when the size isn't known — larger:/smaller: then leave the message in rather than dropping it. */
  size: number | null
  read: boolean
  starred: boolean
  hasAttachment: boolean
  /** Whether the mailbox was written to, copied in, or reached some other way. */
  addressed?: 'direct' | 'copied' | 'other'
  labels: string[]
  folder: string
}

type Term = { negated: boolean; field: string | null; value: string }
export type ParsedQuery = { groups: Term[][]; isEmpty: boolean }

const FIELDS = new Set([
  'from', 'to', 'cc', 'bcc', 'subject', 'body', 'label', 'filename', 'in', 'is', 'has',
  'before', 'after', 'older_than', 'newer_than', 'larger', 'smaller',
])

function tokenize(raw: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const char of raw) {
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) out.push(current)
  return out
}

export function parseQuery(raw: string): ParsedQuery {
  const groups: Term[][] = []
  let orPending = false

  for (const token of tokenize(raw)) {
    if (/^(or|\|)$/i.test(token)) {
      orPending = groups.length > 0
      continue
    }
    let rest = token
    let negated = false
    if (rest.startsWith('-') && rest.length > 1) {
      negated = true
      rest = rest.slice(1)
    }
    const colon = rest.indexOf(':')
    let field: string | null = null
    let value = rest
    if (colon > 0) {
      const candidate = rest.slice(0, colon).toLowerCase()
      if (FIELDS.has(candidate)) {
        field = candidate
        value = rest.slice(colon + 1)
      }
    }
    if (!value) continue
    const term: Term = { negated, field, value: value.toLowerCase() }
    if (orPending && groups.length) groups[groups.length - 1].push(term)
    else groups.push([term])
    orPending = false
  }

  return { groups, isEmpty: groups.length === 0 }
}

/** "7d" / "2w" / "3m" / "1y" -> milliseconds. */
export function duration(value: string): number | null {
  const match = value.match(/^(\d+)\s*([dwmy])$/)
  if (!match) return null
  const amount = Number(match[1])
  const unit = { d: 864e5, w: 6048e5, m: 2592e6, y: 31536e6 }[match[2] as 'd' | 'w' | 'm' | 'y']
  return amount * unit
}

/** "500k" / "5m" / "12345" -> bytes. */
function bytes(value: string): number | null {
  const match = value.match(/^(\d+(?:\.\d+)?)\s*([kmg])?$/)
  if (!match) return null
  const scale = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2] as 'k' | 'm' | 'g'] ?? 1
  return Number(match[1]) * scale
}

function dateValue(value: string): number | null {
  const stamp = Date.parse(value)
  return Number.isNaN(stamp) ? null : stamp
}

function matchTerm(term: Term, doc: SearchDoc): boolean {
  const { field, value } = term
  const has = (haystack: string) => haystack.toLowerCase().includes(value)

  switch (field) {
    case 'from': return has(doc.from)
    case 'to': return has(doc.to)
    case 'cc': return has(doc.cc)
    case 'bcc': return has(doc.bcc)
    case 'subject': return has(doc.subject)
    case 'body': return has(doc.body)
    case 'filename': return has(doc.filenames)
    case 'label': return doc.labels.some(label => label.toLowerCase().includes(value))
    case 'in': return doc.folder.toLowerCase() === value
    case 'is':
      if (value === 'unread') return !doc.read
      if (value === 'read') return doc.read
      if (value === 'starred') return doc.starred
      if (value === 'unstarred') return !doc.starred
      // Copied in, written to, or arrived some other way — a blind copy, a list, an alias.
      if (value === 'copied' || value === 'cc') return doc.addressed === 'copied'
      if (value === 'direct') return doc.addressed === 'direct'
      if (value === 'indirect' || value === 'other') return doc.addressed === 'other'
      return true
    case 'has':
      if (value === 'attachment' || value === 'attachments') return doc.hasAttachment
      if (value === 'link') return /https?:\/\//i.test(doc.body)
      return true
    case 'before': {
      const stamp = dateValue(value)
      return stamp === null ? true : doc.date < stamp
    }
    case 'after': {
      const stamp = dateValue(value)
      return stamp === null ? true : doc.date > stamp
    }
    case 'older_than': {
      const span = duration(value)
      return span === null ? true : doc.date < Date.now() - span
    }
    case 'newer_than': {
      const span = duration(value)
      return span === null ? true : doc.date > Date.now() - span
    }
    case 'larger': {
      const size = bytes(value)
      return size === null || doc.size === null ? true : doc.size > size
    }
    case 'smaller': {
      const size = bytes(value)
      return size === null || doc.size === null ? true : doc.size < size
    }
    default:
      // Free text sweeps everything the message carries, body included.
      return has(`${doc.from} ${doc.to} ${doc.cc} ${doc.subject} ${doc.body} ${doc.filenames}`)
  }
}

export type ServerSearch = {
  text: string
  from?: string
  to?: string
  label?: string
  unread?: boolean
  starred?: boolean
  hasAttachment?: boolean
  /** direct | copied | other | not-copied */
  addressed?: string
}

/**
 * The parts of a query the inbox route can answer itself go to the server; whatever it
 * cannot express stays behind as the residual the browser still has to check.
 */
export function splitForServer(query: ParsedQuery): { server: ServerSearch; residual: ParsedQuery } {
  const server: ServerSearch = { text: '' }
  const words: string[] = []
  const residual: Term[][] = []
  for (const group of query.groups) {
    const term = group.length === 1 ? group[0] : null
    if (term?.negated && term.field === 'is' && (term.value === 'copied' || term.value === 'cc')) {
      server.addressed = 'not-copied'
      continue
    }
    if (!term || term.negated) {
      residual.push(group)
      continue
    }
    if (term.field === null) words.push(term.value)
    else if (term.field === 'from' && !server.from) server.from = term.value
    else if (term.field === 'to' && !server.to) server.to = term.value
    else if (term.field === 'label' && !server.label) server.label = term.value
    else if (term.field === 'is' && term.value === 'unread') server.unread = true
    else if (term.field === 'is' && term.value === 'starred') server.starred = true
    else if (term.field === 'has' && term.value === 'attachment') server.hasAttachment = true
    // Pushed down so the whole mailbox is filtered, not the page the client happens to hold.
    else if (term.field === 'is' && (term.value === 'copied' || term.value === 'cc')) server.addressed = 'copied'
    else if (term.field === 'is' && term.value === 'direct') server.addressed = 'direct'
    else if (term.field === 'is' && (term.value === 'indirect' || term.value === 'other')) server.addressed = 'other'
    else residual.push(group)
  }
  server.text = words.join(' ')
  return { server, residual: { groups: residual, isEmpty: residual.length === 0 } }
}

export function serverSearchParams(raw: string): Record<string, string> {
  const { server } = splitForServer(parseQuery(raw))
  const params: Record<string, string> = {}
  if (server.text) params.q = server.text
  if (server.from) params.from = server.from
  if (server.to) params.to = server.to
  if (server.label) params.label = server.label
  if (server.unread) params.unread = '1'
  if (server.starred) params.starred = '1'
  if (server.hasAttachment) params.attachment = '1'
  if (server.addressed) params.addressed = server.addressed
  return params
}

export function matchesQuery(query: ParsedQuery, doc: SearchDoc): boolean {
  if (query.isEmpty) return true
  return query.groups.every(group =>
    group.some(term => (term.negated ? !matchTerm(term, doc) : matchTerm(term, doc))),
  )
}
