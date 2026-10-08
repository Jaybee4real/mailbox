import { db, ensureMailSchema } from './mailbox'

export type BlockReason = 'bounce' | 'complaint' | 'manual'

export type BlockedAddress = {
  address: string
  reason: BlockReason
  detail: string | null
  createdAt: string
}

export const bareAddress = (raw: string): string => (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase()

const REASON_TEXT: Record<BlockReason, string> = {
  bounce: 'mail to it bounced',
  complaint: 'its owner marked our mail as spam',
  manual: 'an admin blocked it',
}

export function blockedSentence(entry: Pick<BlockedAddress, 'address' | 'reason' | 'createdAt'>): string {
  const day = new Date(entry.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return `${entry.address} is blocked: ${REASON_TEXT[entry.reason] ?? 'it is on the blocked list'} (${day})`
}

export class BlockedRecipientsError extends Error {
  blocked: BlockedAddress[]
  constructor(blocked: BlockedAddress[]) {
    super(`Not sent. ${blocked.map(blockedSentence).join('. ')}. Remove ${blocked.length > 1 ? 'them' : 'it'} to send, or ask an admin to unblock ${blocked.length > 1 ? 'them' : 'it'}.`)
    this.name = 'BlockedRecipientsError'
    this.blocked = blocked
  }
}

const toEntry = (row: Record<string, unknown>): BlockedAddress => ({
  address: String(row.address),
  reason: (['bounce', 'complaint', 'manual'].includes(String(row.reason)) ? String(row.reason) : 'manual') as BlockReason,
  detail: row.detail == null ? null : String(row.detail),
  createdAt: String(row.created_at),
})

/** Vela keeps the list every mailbox on it shares; null when this deployment sends some other way. */
function vela(): { base: string; key: string } | null {
  const base = process.env.RESEND_BASE_URL?.trim().replace(/\/+$/, '')
  const key = process.env.RESEND_API_KEY?.trim()
  return base && key && !/api\.resend\.com/i.test(base) ? { base, key } : null
}

async function velaCall<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T | null> {
  const target = vela()
  if (!target) return null
  try {
    const response = await fetch(`${target.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${target.key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as T
  } catch (err) {
    console.error(`[mail] Vela blocked list ${method} ${path} failed:`, err)
    return null
  }
}

type VelaEntry = { address: string; reason: string; detail: string | null; createdAt: string; shared: boolean }

const asReason = (value: string): BlockReason => (value === 'bounce' || value === 'complaint' ? value : 'manual')

export async function blockedAmong(recipients: string[]): Promise<BlockedAddress[]> {
  const addresses = [...new Set(recipients.map(bareAddress).filter(Boolean))]
  if (!addresses.length) return []
  await ensureMailSchema()
  const rows = await db()`SELECT address, reason, detail, created_at FROM mail_blocked WHERE address IN (SELECT value FROM json_each(${JSON.stringify(addresses)}))`
  const found = rows.map(toEntry)
  const unknown = addresses.filter(address => !found.some(entry => entry.address === address))
  if (!unknown.length) return found
  const checked = await velaCall<{ data?: VelaEntry[] }>('POST', '/suppressions/check', { addresses: unknown })
  for (const entry of checked?.data ?? []) {
    const learned = { address: bareAddress(entry.address), reason: asReason(entry.reason), detail: entry.detail, createdAt: entry.createdAt }
    await remember(learned)
    found.push(learned)
  }
  return found
}

async function remember(entry: BlockedAddress): Promise<void> {
  await db()`
    INSERT INTO mail_blocked (address, reason, detail, created_at) VALUES (${entry.address}, ${entry.reason}, ${entry.detail}, ${entry.createdAt})
    ON CONFLICT (address) DO UPDATE SET reason = excluded.reason, detail = coalesce(excluded.detail, mail_blocked.detail)`
}

export async function listBlocked(): Promise<BlockedAddress[]> {
  await ensureMailSchema()
  const rows = await db()`SELECT address, reason, detail, created_at FROM mail_blocked ORDER BY created_at DESC`
  return rows.map(toEntry)
}

/**
 * A bounce or complaint is about the address, so it is shared through Vela with every mailbox
 * there; an admin's own block stays in this mailbox. `shareWithVela` is off for events Vela sent us.
 */
export async function blockAddress(
  address: string,
  reason: BlockReason,
  detail: string | null = null,
  at = new Date().toISOString(),
  shareWithVela = reason !== 'manual',
): Promise<void> {
  const clean = bareAddress(address)
  if (!clean.includes('@')) return
  await ensureMailSchema()
  await remember({ address: clean, reason, detail, createdAt: at })
  if (shareWithVela) await velaCall('POST', '/suppressions', { address: clean, reason, detail })
}

/** Returns a warning when Vela's shared list still holds the address, so mail to it is still refused. */
export async function unblockAddress(address: string): Promise<string | null> {
  const clean = bareAddress(address)
  await ensureMailSchema()
  await db()`DELETE FROM mail_blocked WHERE address = ${clean}`
  const lifted = await velaCall<{ still_blocked?: VelaEntry | null }>('DELETE', `/suppressions?address=${encodeURIComponent(clean)}`)
  if (!lifted?.still_blocked) return null
  return `${clean} is still blocked on Vela's shared list because ${REASON_TEXT[asReason(lifted.still_blocked.reason)]}. Novacraft support can lift it there.`
}
