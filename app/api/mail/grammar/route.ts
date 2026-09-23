import { NextResponse } from 'next/server'
import { mailAuthGuard } from '@/lib/dev-auth'

export const runtime = 'nodejs'

const server = () => process.env.LANGUAGETOOL_URL?.trim().replace(/\/+$/, '') || ''

// Spelling is checked in the browser against the company's own dictionaries; LanguageTool's
// spell rule would flag every client and insurer name a second time. The whitespace rule
// fires on the no-break spaces the Tab key inserts.
const SKIPPED_RULES = /^(MORFOLOGIK_RULE|HUNSPELL_RULE|WHITESPACE_RULE|CONSECUTIVE_SPACES|EN_QUOTES|DASH_RULE|UPPERCASE_SENTENCE_START|ENGLISH_WORD_REPEAT_RULE)/

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  return NextResponse.json({ ok: true, available: Boolean(server()) })
}

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const base = server()
  if (!base) return NextResponse.json({ ok: false, error: 'Grammar checking is not set up' }, { status: 503 })
  let body: { text?: unknown; language?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const text = typeof body.text === 'string' ? body.text.slice(0, 20000) : ''
  const language = body.language === 'en-US' ? 'en-US' : 'en-GB'
  if (!text.trim()) return NextResponse.json({ ok: true, matches: [] })
  const upstream = await fetch(`${base}/v2/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ text, language, level: 'default' }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null)
  if (!upstream?.ok) return NextResponse.json({ ok: false, error: 'The grammar server did not answer' }, { status: 502 })
  const data = (await upstream.json()) as {
    matches?: Array<{ offset: number; length: number; message: string; replacements?: Array<{ value: string }>; rule?: { id?: string } }>
  }
  const matches = (data.matches ?? [])
    .filter(match => !SKIPPED_RULES.test(match.rule?.id ?? ''))
    .map(match => ({
      offset: match.offset,
      length: match.length,
      message: match.message,
      replacements: (match.replacements ?? []).slice(0, 5).map(entry => entry.value),
    }))
  return NextResponse.json({ ok: true, matches })
}
