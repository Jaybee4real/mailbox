import { ADDRESS_DOMAINS } from './brand.ts'

export type SenderStanding = {
  received: number
  trashed: number
  markedSpam: number
  replied: number
  /** Someone in this mailbox said so. */
  trusted: boolean
  /** The earliest mail this mailbox holds from the sender's domain, whoever it went to. */
  firstSeen: string | null
}

export const FIRST_MESSAGE_REASON = 'This is the first message from this sender'

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
  receivedAt?: string | null
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
  const fromDomain = registrable(domainOf(signals.from ?? ''))
  const authenticated = /^pass$/i.test((signals.dmarc ?? '').trim())
  // Our own domain, proven by DMARC: the website's forms and the platform's own notices.
  // They set Reply-To to the customer on purpose and arrive from an address nobody writes back to.
  const ownDomain = authenticated && ADDRESS_DOMAINS.some(domain => registrable(domain) === fromDomain)
  const trusted = (standing.replied > 0 || standing.trusted || ownDomain) && standing.markedSpam === 0
  if (standing.markedSpam > 0) {
    add(4 + Math.min(standing.markedSpam, 4),
      `You marked ${standing.markedSpam} earlier message${standing.markedSpam === 1 ? '' : 's'} from this sender as spam`, true)
  } else if (standing.trashed >= 3 && standing.replied === 0) {
    add(3, `You have deleted ${standing.trashed} messages from this sender without ever replying`, true)
  }

  if (/^fail$/i.test((signals.spam ?? '').trim())) add(4, 'The provider\u2019s spam filter flagged this message', true)

  // Heavy, but not enough on its own to hide a message: mail forwarded through a list
  // breaks alignment and fails DMARC while being perfectly legitimate. It warns loudly;
  // it takes a second finding to put a message out of sight.
  if (failed(signals.dmarc)) add(4, 'The sending domain says this message is not from them (DMARC failed)')
  else if (!authenticated) {
    if (failed(signals.spf)) add(2, 'The sending server is not authorised by that domain (SPF failed)')
    if (failed(signals.dkim)) add(2, 'The signature does not match the sending domain (DKIM failed)')
  }

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
  const seenBefore = Boolean(standing.firstSeen) && (!signals.receivedAt || standing.firstSeen! < signals.receivedAt)
  if (!trusted && !seenBefore && score > 0) add(1, FIRST_MESSAGE_REASON)

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
