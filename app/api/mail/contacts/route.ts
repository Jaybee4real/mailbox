import { NextResponse } from 'next/server'
import { mailAuthGuard } from '@/lib/dev-auth'
import { searchContacts } from '@/lib/mailbox'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const query = new URL(req.url).searchParams.get('q') ?? ''
  const contacts = await searchContacts(query)
  return NextResponse.json({ ok: true, contacts })
}
