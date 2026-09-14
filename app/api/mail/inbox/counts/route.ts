import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { countFolders, countFoldersCached } from '@/lib/mailbox'

const COUNTS_TTL_MS = 20 * 1000
const countsCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof countFolders>> }>()
async function cachedCounts(owner: string) {
  const hit = countsCache.get(owner)
  if (hit && Date.now() - hit.at < COUNTS_TTL_MS) return hit.value
  const value = await countFoldersCached(owner)
  countsCache.set(owner, { at: Date.now(), value })
  return value
}

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  // Counts describe the signed-in mailbox, matching what the list will actually show.
  const account = await resolveAccount(req)
  const counts = await cachedCounts(account.address ?? ' no-address')
  return NextResponse.json({ ok: true, counts })
}
