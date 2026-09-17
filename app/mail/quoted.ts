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
  '[id$="divRplyFwdMsg" i]',
  '[class*="gmail_quote_container" i]',
  'blockquote[class*="gmail_quote" i]',
  'blockquote[type="cite" i]',
  'blockquote[id*="blockquote_zmail" i]',
  '[class*="moz-cite-prefix" i]',
  '[id$="appendonsend" i]',
].join(',')

/** An attribution line: the date-and-name sentence a client writes above the quote. */
const ATTRIBUTION = [
  /^\s*On\b[\s\S]{10,220}?\bwrote:\s*$/i,
  /^\s*-{4,}\s*On\b[\s\S]{10,220}?\bwrote\s*-{4,}\s*$/i,
  /^\s*-{2,20}\s*(?:Original Message|Original message|Forwarded message)\s*-{2,20}\s*$/i,
  /^\s*Begin forwarded message:\s*$/i,
]

/** A header block — only trusted when From: is followed by Sent:/Date:, never alone. */
const HEADER_BLOCK = /^\s*(?:\*\s*)?(?:From|De)\s*:\s*\S[\s\S]{0,400}?^\s*(?:\*\s*)?(?:Sent|Date|Enviado)\s*:/im

/** Text the reader must keep: if trimming leaves less than this, nothing is trimmed. */
const MIN_HEAD_CHARS = 25

function isQuoteStart(element: Element): boolean {
  if (element.matches(CONTAINER)) return true
  const text = (element.textContent ?? '').trim()
  if (!text) return false
  if (text.length < 400 && ATTRIBUTION.some(pattern => pattern.test(text))) return true
  // A divider drawn as a rule or a run of underscores only counts when a header block follows.
  const looksLikeDivider = element.tagName === 'HR' || /^[_—-]{10,}$/.test(text)
  if (looksLikeDivider) return false
  return text.length < 1200 && HEADER_BLOCK.test(text)
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
  const at = children.findIndex(isQuoteStart)
  if (at <= 0) return { head: html, tail: null }

  const head = children.slice(0, at)
  if (head.map(element => element.textContent ?? '').join(' ').trim().length < MIN_HEAD_CHARS) {
    return { head: html, tail: null }
  }
  const tail = children.slice(at)
  return {
    head: head.map(element => element.outerHTML).join(''),
    tail: tail.map(element => element.outerHTML).join(''),
  }
}
