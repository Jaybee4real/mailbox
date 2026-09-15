import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { listThreads, threadsLive, type ThreadFolder } from '@/lib/mailbox'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  if (!threadsLive()) return NextResponse.json({ ok: true, threads: [] })
  const account = await resolveAccount(req)
  const url = new URL(req.url)
  const folderParam = url.searchParams.get('folder')
  const folder: ThreadFolder = (['inbox', 'archive', 'trash', 'starred', 'snoozed'] as const).find(f => f === folderParam) ?? 'inbox'
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 500) || 500, 1000)
  const page = await listThreads(account.address ?? ' no-address', folder, limit, url.searchParams.get('cursor'))
  return NextResponse.json({ ok: true, threads: page.rows, nextCursor: page.nextCursor })
}
