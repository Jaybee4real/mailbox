import { BRAND } from '@/lib/brand'
import { NextResponse } from 'next/server'
import { FORWARD_RECIPIENTS, mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { readSentFlags, setSentFlags, readPixelOpens, readSentMeta, setSentMetaOwner, listAccounts, readSentArchive, type SentFlags } from '@/lib/mailbox'

const SHARED_ADDRESS = (process.env.RESEND_FROM ?? BRAND.supportEmail).replace(/^.*<|>$/g, '').trim().toLowerCase()

function fromAddressOf(email: SentEmail): string {
  return (email.from.match(/<([^>]+)>/)?.[1] ?? email.from).trim().toLowerCase()
}

export const runtime = 'nodejs'

type SentEmail = { id: string; from: string; to: string[]; subject: string; createdAt: string; scheduledAt: string | null; lastEvent: string }

const KNOWN_AUTO_SUBJECTS = new Set(['Reset your Metro Peril Mail password'])

/** Heuristic for pre-existing automated sends that predate owner/auto tagging. */
function looksAutomated(email: SentEmail): boolean {
  if (email.subject.startsWith('Fwd:')) return true
  if (KNOWN_AUTO_SUBJECTS.has(email.subject)) return true
  const internal = new Set(
    [...FORWARD_RECIPIENTS, ...(process.env.RESEND_TO ?? '').split(',')]
      .map(addr => addr.trim().toLowerCase())
      .filter(Boolean),
  )
  const recipients = email.to
    .map(entry => (entry.match(/<([^>]+)>/)?.[1] ?? entry).trim().toLowerCase())
    .filter(Boolean)
  return recipients.length > 0 && recipients.every(addr => internal.has(addr))
}

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  const account = await resolveAccount(req)
  // Read our own archive rather than the provider's list: the history stays ours across
  // a provider switch, and every send is written here at send time.
  // Meta is looked up only for the archive rows being returned, so fetch those first.
  const archive = await readSentArchive().catch(() => [])
  const [flags, opens, sentMeta, accounts] = await Promise.all([
    readSentFlags().catch(() => ({})),
    readPixelOpens().catch(() => ({})),
    readSentMeta(archive.map(item => item.id)).catch(() => ({})),
    listAccounts().catch(() => []),
  ])

  const all: SentEmail[] = archive.map(item => ({
    id: item.id,
    from: item.from,
    to: item.to,
    subject: item.subject || '(no subject)',
    createdAt: item.createdAt,
    scheduledAt: null,
    lastEvent: item.lastEvent ?? '',
  }))

  // Sent mail is scoped the same way the inbox is: to the signed-in mailbox, whatever
  // the role. Administering accounts does not carry the right to read someone's sends.
  const ownerScope: string = account.address ?? ' no-address'

  // Ownership is the sender identity: the `from` address if it's an accessor's, else the
  // shared inbox (admin). This attributes historical sends (all from hello@) correctly.
  const accountAddresses = new Set(accounts.filter(entry => entry.address).map(entry => entry.address!.toLowerCase()))
  const metaMap = sentMeta as Record<string, { owner: string | null; isAuto: boolean; inReplyTo: string | null }>
  const sentOwner = (email: SentEmail): string => {
    // An explicit assignment wins; otherwise the sender identity is the `from` address.
    const assigned = metaMap[email.id]?.owner
    if (assigned) return assigned
    const from = fromAddressOf(email)
    return accountAddresses.has(from) ? from : SHARED_ADDRESS
  }

  const emails = all
    .filter(email => {
      const meta = metaMap[email.id]
      if (meta?.isAuto) return false // tagged automated → never in Sent
      if (!meta && looksAutomated(email)) return false // pre-existing automated → excluded
      if (ownerScope) return sentOwner(email) === ownerScope
      return true
    })
    .map(email => ({ ...email, owner: sentOwner(email), inReplyTo: metaMap[email.id]?.inReplyTo ?? null }))

  return NextResponse.json({ ok: true, emails, flags, opens })
}

export async function PATCH(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  let body: { id?: string; ids?: string[]; owner?: string } & SentFlags
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const ids = body.ids ?? (body.id ? [body.id] : [])
  if (!ids.length) return NextResponse.json({ ok: false, error: 'id or ids is required' }, { status: 400 })

  // Reassigning a message to a mailbox is admin-only.
  if (body.owner !== undefined) {
    const account = await resolveAccount(req)
    if (account.role !== 'admin') {
      return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 })
    }
    await Promise.all(ids.map(id => setSentMetaOwner(id, body.owner!)))
    return NextResponse.json({ ok: true })
  }

  const flags: SentFlags = {}
  if (body.starred !== undefined) flags.starred = body.starred
  if (body.archived !== undefined) flags.archived = body.archived
  if (body.trashed !== undefined) flags.trashed = body.trashed
  await Promise.all(ids.map(id => setSentFlags(id, flags)))
  return NextResponse.json({ ok: true })
}
