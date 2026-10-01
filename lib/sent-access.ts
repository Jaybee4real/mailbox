import { BRAND } from '@/lib/brand'
import { getInboundSource, listAccounts, readSentMeta, readSentSenders } from '@/lib/mailbox'
import { readsAllInboxes, SHARED_INBOX, type Viewer } from '@/lib/scope'

const SHARED_ADDRESS = (process.env.RESEND_FROM ?? BRAND.supportEmail).replace(/^.*<|>$/g, '').trim().toLowerCase()

/**
 * The mailbox each sent message belongs to: the one it is assigned to, else the one whose
 * address sent it, with unattributed sends belonging to the shared address. Mirrors the
 * scoping of the Sent list, so nothing is readable by id that is not listable.
 */
export async function sentOwners(ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)]
  const owners: Record<string, string> = {}
  if (!unique.length) return owners
  const metas: Record<string, { owner: string | null }> = await readSentMeta(unique).catch(() => ({}))
  const unassigned: string[] = []
  for (const id of unique) {
    const assigned = metas[id]?.owner
    if (assigned) owners[id] = assigned.toLowerCase()
    else unassigned.push(id)
  }
  if (!unassigned.length) return owners
  const senders = await readSentSenders(unassigned).catch((): Record<string, string> => ({}))
  const known = unassigned.some(id => id in senders)
    ? new Set((await listAccounts()).filter(entry => entry.address).map(entry => entry.address!.toLowerCase()))
    : new Set<string>()
  for (const id of unassigned) {
    const raw = senders[id] ?? ''
    const from = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase()
    owners[id] = known.has(from) ? from : SHARED_ADDRESS
  }
  return owners
}

export async function mayReadSent(account: { address: string | null }, id: string): Promise<boolean> {
  const scope = account.address?.trim().toLowerCase()
  if (!scope) return false
  return (await sentOwners([id]))[id] === scope
}

export async function mayReadInbound(viewer: Viewer, id: string): Promise<boolean> {
  if (readsAllInboxes(viewer)) return true
  const scope = viewer.address?.trim().toLowerCase()
  if (!scope) return false
  const source = await getInboundSource(id).catch(() => null)
  return source !== null && (source.owner ?? SHARED_INBOX).toLowerCase() === scope
}
