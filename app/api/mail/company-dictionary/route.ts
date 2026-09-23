import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { getSettings, setSettings } from '@/lib/mailbox'

export const runtime = 'nodejs'

const COMPANY = '__company__'

const wordsFrom = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((word): word is string => typeof word === 'string').map(word => word.trim()).filter(word => word && word.length <= 60))].slice(0, 5000)
    : []

/** Words everyone's spelling check accepts: client, insurer and product names. */
export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const stored = await getSettings(COMPANY)
  return NextResponse.json({ ok: true, words: wordsFrom(stored.dictionary) })
}

export async function PUT(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (account.role !== 'admin') return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 })
  let body: { words?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const words = wordsFrom(body.words)
  await setSettings(COMPANY, { ...(await getSettings(COMPANY)), dictionary: words })
  return NextResponse.json({ ok: true, words })
}
