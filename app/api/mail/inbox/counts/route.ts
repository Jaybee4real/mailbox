import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { inboxScope } from '@/lib/scope'
import { countFolders, countFoldersCached } from '@/lib/mailbox'

const COUNTS_TTL_MS = 20 * 1000
const countsCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof countFolders>> }>()
async function cachedCounts(owner: string | null, fresh: boolean) {
  const hit = countsCache.get(owner ?? '*all')
  if (!fresh && hit && Date.now() - hit.at < COUNTS_TTL_MS) return hit.value
  const value = fresh ? await countFolders(owner ?? undefined) : await countFoldersCached(owner)
  countsCache.set(owner ?? '*all', { at: Date.now(), value })
  return value
}

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  // Counts describe the signed-in mailbox, matching what the list will actually show.
  const account = await resolveAccount(req)
  const fresh = new URL(req.url).searchParams.get('fresh') === '1'
  const counts = await cachedCounts(inboxScope(account), fresh)
  return NextResponse.json({ ok: true, counts })
}
