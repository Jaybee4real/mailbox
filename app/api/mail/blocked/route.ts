import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { bareAddress, blockAddress, listBlocked, unblockAddress } from '@/lib/blocked'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  return NextResponse.json({ ok: true, blocked: await listBlocked() })
}

async function adminBody(req: Request): Promise<{ address: string; note: string | null } | NextResponse> {
  const account = await resolveAccount(req)
  if (account.role !== 'admin') return NextResponse.json({ ok: false, error: 'Only an admin can change the blocked list' }, { status: 403 })
  const body = (await req.json().catch(() => null)) as { address?: unknown; note?: unknown } | null
  const address = bareAddress(String(body?.address ?? ''))
  if (!EMAIL_RE.test(address)) return NextResponse.json({ ok: false, error: 'Enter a full email address' }, { status: 400 })
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : null
  return { address, note }
}

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const input = await adminBody(req)
  if (input instanceof NextResponse) return input
  await blockAddress(input.address, 'manual', input.note)
  return NextResponse.json({ ok: true, blocked: await listBlocked() })
}

export async function DELETE(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const input = await adminBody(req)
  if (input instanceof NextResponse) return input
  const warning = await unblockAddress(input.address)
  return NextResponse.json({ ok: true, warning, blocked: await listBlocked() })
}
