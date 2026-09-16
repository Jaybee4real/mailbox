import { BRAND } from '@/lib/brand'
import { listAccounts, readSentMessage, readSentMeta } from '@/lib/mailbox'

const SHARED_ADDRESS = (process.env.RESEND_FROM ?? BRAND.supportEmail).replace(/^.*<|>$/g, '').trim().toLowerCase()

/**
 * Whether this mailbox may read a sent message: the one it is assigned to, else the one
 * whose address sent it, with unattributed sends belonging to the shared address. Mirrors
 * the scoping of the Sent list, so nothing is readable by id that is not listable.
 */
export async function mayReadSent(account: { address: string | null }, id: string): Promise<boolean> {
  const scope = account.address?.trim().toLowerCase()
  if (!scope) return false
  const metas: Record<string, { owner: string | null }> = await readSentMeta([id]).catch(() => ({}))
  const meta = metas[id]
  if (meta?.owner) return meta.owner.toLowerCase() === scope
  const stored = await readSentMessage(id).catch(() => null)
  if (!stored) return scope === SHARED_ADDRESS
  const from = (stored.from.match(/<([^>]+)>/)?.[1] ?? stored.from).trim().toLowerCase()
  const known = new Set((await listAccounts()).filter(entry => entry.address).map(entry => entry.address!.toLowerCase()))
  return (known.has(from) ? from : SHARED_ADDRESS) === scope
}
