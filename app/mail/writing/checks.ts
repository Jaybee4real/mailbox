import type { WritingSettings } from './settings'

export type SendCheckInput = {
  /** What the sender wrote: no signature, no quoted message. */
  body: string
  recipients: Array<{ email: string; name?: string | null }>
  attachmentCount: number
  ownDomains: string[]
}

export type SendIssue = { kind: 'attachment' | 'empty' | 'placeholder' | 'greeting' | 'external'; message: string }

const PROMISES_ATTACHMENT =
  /\b(attached|attachments?|enclosed|enclosing|herewith|I(?:'ve| have) (?:also )?(?:included|added) the (?:file|document|schedule|form|quote|policy|invoice))\b/i
const PLACEHOLDER = /\[(?![Cc]id:)[^\]\n]{1,40}\]|\{[A-Za-z_ ]{1,30}\}|<<[^>\n]{1,40}>>|\bX{3,}\b|\bTBD\b|\bTODO\b/
const GREETING = /^\s*(?:dear|hi|hello|hey|good (?:morning|afternoon|evening))[ ,]+(?:(?:mr|mrs|ms|miss|dr|prof|engr|chief|sir|madam|barr|alh(?:aji)?|hajia)\.?\s+)?([A-Za-z][A-Za-z'-]{1,30})/i
const GENERIC = new Set(['sir', 'madam', 'sirs', 'all', 'team', 'everyone', 'colleague', 'colleagues', 'gentlemen', 'there', 'friend', 'client', 'customer', 'valued', 'concerned', 'whom', 'both', 'you'])

const domainOf = (email: string) => email.trim().toLowerCase().split('@')[1] ?? ''

/** What looks wrong with a message before it goes, each on its own switch. */
export function sendIssues(input: SendCheckInput, settings: WritingSettings): SendIssue[] {
  const issues: SendIssue[] = []
  const body = input.body.trim()

  if (settings.checkEmptyBody && !body) {
    issues.push({ kind: 'empty', message: 'The message has no text of your own — only the signature or the quoted message.' })
  }
  if (settings.checkAttachment && input.attachmentCount === 0) {
    const promise = body.match(PROMISES_ATTACHMENT)
    if (promise) issues.push({ kind: 'attachment', message: `It says “${promise[0]}”, but nothing is attached.` })
  }
  if (settings.checkPlaceholders) {
    const left = body.match(PLACEHOLDER)
    if (left) issues.push({ kind: 'placeholder', message: `“${left[0]}” looks like a placeholder that was never filled in.` })
  }
  if (settings.checkGreeting) {
    const greeted = body.split('\n').find(line => line.trim())?.match(GREETING)?.[1]
    if (greeted && /^[A-Z]/.test(greeted) && !GENERIC.has(greeted.toLowerCase())) {
      const target = greeted.toLowerCase()
      const matches = input.recipients.some(recipient => {
        const haystack = `${recipient.name ?? ''} ${recipient.email.split('@')[0]}`.toLowerCase()
        return haystack.includes(target) || (target.length >= 4 && haystack.includes(target.slice(0, 4)))
      })
      if (!matches && input.recipients.length) {
        issues.push({ kind: 'greeting', message: `The greeting names “${greeted}”, but no recipient looks like ${greeted}.` })
      }
    }
  }
  if (settings.checkExternal) {
    const own = new Set(input.ownDomains.map(domain => domain.toLowerCase()))
    const outside = input.recipients.filter(recipient => !own.has(domainOf(recipient.email)))
    if (outside.length >= settings.externalThreshold) {
      issues.push({ kind: 'external', message: `It goes to ${outside.length} people outside the company.` })
    }
  }
  return issues
}
