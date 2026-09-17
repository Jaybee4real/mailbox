/**
 * Where a received message stops being new and starts repeating the thread.
 *
 * Mail clients append the entire earlier conversation under a reply, so a long thread
 * carries the first message a dozen times over. The boundary is found, the repeat is
 * folded away, and the reader is offered it rather than made to scroll past it.
 *
 * Every rule here was measured against the real mailbox, and the near misses matter more
 * than the hits: a bare "From:" line fires on ordinary sentences a thousand times over, and
 * a row of underscores is a decoration as often as a divider. Only the conjunctions are
 * trusted — the divider AND the header block that must follow it.
 */

const CONTAINER = [
  // Outlook stacks a prefix onto the id on every requote, so match the suffix.
  '[id$="divRplyFwdMsg" i]',
  // Outlook Web draws this rule immediately above that div; every instance in the corpus
  // sits on a real boundary, while a bare <hr> is decorative half the time.
  'hr[style*="inline-block"][style*="98%"]',
  // Outlook desktop flattens the same boundary to a bordered div.
  'div[style*="border-top"][style*="#E1E1E1" i]',
  '[class*="gmail_quote_container" i]',
  'blockquote[class*="gmail_quote" i]',
  'blockquote[type="cite" i]',
  'blockquote[id*="blockquote_zmail" i]',
  '[class*="moz-cite-prefix" i]',
].join(',')

// Deliberately absent: Outlook's empty "appendonsend" anchor. It marks where typing stopped,
// which looks like the ideal cut, but the sender's signature is sometimes emitted after it.

/** A reply divider: everything below it is the thread being repeated. */
const REPLY_DIVIDER = [
  /^\s*On\b[\s\S]{10,220}?\bwrote:\s*$/i,
  /^\s*-{4,}\s*On\b[\s\S]{10,220}?\bwrote\s*-{4,}\s*$/i,
]

/**
 * A forward marker means the opposite of a reply divider: what follows is not a repeat,
 * it is the whole point of the message. Folding it on a bare forward would leave the
 * reader a cover note and a fold line, so it is only honoured under a real covering note.
 */
const FORWARD_MARKER = [
  /^\s*-{2,20}\s*(?:Original Message|Original message|Forwarded message)\s*-{2,20}\s*$/i,
  /^\s*Begin forwarded message:\s*$/i,
]

/** A header block — only trusted when From: is followed by Sent:/Date:, never alone. */
const HEADER_BLOCK = /^\s*(?:\*\s*)?(?:From|De)\s*:\s*\S[\s\S]{0,400}?^\s*(?:\*\s*)?(?:Sent|Date|Enviado)\s*:/im

/** Text the reader must keep: if trimming leaves less than this, nothing is trimmed. */
const MIN_HEAD_CHARS = 25
/** A forward needs a substantial note of its own before its body may be folded. */
const MIN_HEAD_CHARS_FORWARD = 150

type Boundary = 'reply' | 'forward' | null

function quoteStart(element: Element): Boundary {
  if (element.matches(CONTAINER)) return 'reply'
  const text = (element.textContent ?? '').trim()
  if (!text) return null
  if (text.length < 400 && REPLY_DIVIDER.some(pattern => pattern.test(text))) return 'reply'
  if (text.length < 400 && FORWARD_MARKER.some(pattern => pattern.test(text))) return 'forward'
  // A divider drawn as a rule or a run of underscores only counts when a header block follows.
  const looksLikeDivider = element.tagName === 'HR' || /^[_—-]{10,}$/.test(text)
  if (looksLikeDivider) return null
  return text.length < 1200 && HEADER_BLOCK.test(text) ? 'reply' : null
}

export type QuotedSplit = { head: string; tail: string | null }

/**
 * Splits a message body into what was written now and what is being repeated.
 * Returns tail = null when there is no repeat, or when trimming would leave nothing to read.
 */
export function splitQuotedTail(html: string): QuotedSplit {
  if (typeof window === 'undefined' || !html) return { head: html, tail: null }
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return { head: html, tail: null }
  }
  const body = doc.body
  if (!body) return { head: html, tail: null }

  // Walk the outermost run of siblings, descending through wrapper divs that hold everything.
  let scope: Element = body
  for (let depth = 0; depth < 6; depth++) {
    const elements = Array.from(scope.children)
    if (elements.length !== 1 || !/^(div|table|tbody|tr|td|section|article)$/i.test(elements[0].tagName)) break
    if (elements[0].matches(CONTAINER)) break
    scope = elements[0]
  }

  const children = Array.from(scope.children)
  let at = -1
  let kind: Boundary = null
  for (const [index, element] of children.entries()) {
    const boundary = quoteStart(element)
    if (boundary) { at = index; kind = boundary; break }
  }
  if (at <= 0) return { head: html, tail: null }

  const head = children.slice(0, at)
  const kept = head.map(element => element.textContent ?? '').join(' ').trim().length
  if (kept < (kind === 'forward' ? MIN_HEAD_CHARS_FORWARD : MIN_HEAD_CHARS)) {
    return { head: html, tail: null }
  }
  const tail = children.slice(at)
  return {
    head: head.map(element => element.outerHTML).join(''),
    tail: tail.map(element => element.outerHTML).join(''),
  }
}

/**
 * The same boundary in a message that arrived as plain text only.
 *
 * Half the bodies in the archive are text with no HTML part, and they quote just as
 * heavily — so the reader needs this as much as the HTML path. Each pattern below was
 * counted against the real archive, and the two that looked obvious are the two that
 * had to be rejected: a lone "From:" heads every bounce report, and a row of underscores
 * is a confidentiality footer more often than a divider.
 */
const TEXT_REPLY = [
  // A run of underscores, but only where the quoted headers actually follow it.
  /(?:^|\r?\n)[ \t]*_{10,}[ \t]*(?:\r?\n)+(?=[ \t]*(?:>[ \t]*)*(?:From|De)[ \t]*:[ \t])/,
  // The header block itself: From, then Sent or Date, then To or Cc.
  /(?:^|\r?\n)(?:>[ \t]*)*(?:From|De)[ \t]*:[ \t][^\n]{1,400}(?:[ \t]*\r?\n)+(?:>[ \t]*)*(?:Sent|Date|Enviado)[ \t]*:[ \t][^\n]{1,200}(?:[ \t]*\r?\n)+(?:>[ \t]*)*(?:To|Cc|Para)[ \t]*:[ \t]/,
  // The attribution sentence, allowed to wrap over a few lines.
  /(?:^|\r?\n)[ \t>]*On\b(?:[^\n]*\n){0,3}?[^\n]*\bwrote:[ \t]*(?=\r?\n|$)/,
  /(?:^|\r?\n)[ \t>]*-{4,}[ \t]*On\b[^\n]{0,300}?wrote[ \t]*-{4,}[ \t]*$/m,
]

const TEXT_FORWARD = [
  /(?:^|\r?\n)[ \t>]*-{2,20}[ \t]?(?:Original Message|Original message|Forwarded message)[ \t]?-{2,20}[ \t]*(?=\r?\n|$)/,
  /(?:^|\r?\n)[ \t]*Begin forwarded message:[ \t]*(?=\r?\n|$)/,
]

export type TextSplit = { head: string; tail: string | null }

export function splitQuotedText(text: string): TextSplit {
  if (!text) return { head: text, tail: null }
  let cut = -1
  let kind: Boundary = null
  for (const [patterns, boundary] of [[TEXT_REPLY, 'reply'], [TEXT_FORWARD, 'forward']] as const) {
    for (const pattern of patterns) {
      const match = pattern.exec(text)
      if (!match) continue
      // Cut at the divider itself, not after the newline that introduced it.
      const at = match.index + (/^\r?\n/.test(match[0]) ? 1 : 0)
      if (cut === -1 || at < cut) { cut = at; kind = boundary }
    }
  }
  if (cut <= 0) return { head: text, tail: null }
  const head = text.slice(0, cut)
  if (head.trim().length < (kind === 'forward' ? MIN_HEAD_CHARS_FORWARD : MIN_HEAD_CHARS)) {
    return { head: text, tail: null }
  }
  return { head: head.replace(/\s+$/, ''), tail: text.slice(cut) }
}
