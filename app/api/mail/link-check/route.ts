import { NextResponse } from 'next/server'
import { mailAuthGuard } from '@/lib/dev-auth'
import { inspectUrl, mergeVerdict, normalizeUrl, type LinkVerdict } from '@/lib/link-safety'

export const runtime = 'nodejs'

const SAFE_BROWSING = 'https://safebrowsing.googleapis.com/v4/threatMatches:find'

// Verdicts are stable for a while and emails get re-opened constantly — cache per instance.
const cache = new Map<string, { verdict: LinkVerdict; reasons: string[]; at: number }>()
const TTL_MS = 6 * 60 * 60 * 1000

const THREAT_LABEL: Record<string, string> = {
  MALWARE: 'Known malware host (Google Safe Browsing)',
  SOCIAL_ENGINEERING: 'Known phishing site (Google Safe Browsing)',
  UNWANTED_SOFTWARE: 'Distributes unwanted software (Google Safe Browsing)',
  POTENTIALLY_HARMFUL_APPLICATION: 'Potentially harmful application (Google Safe Browsing)',
}

async function lookupRemote(urls: string[]): Promise<Map<string, string[]>> {
  const key = process.env.SAFE_BROWSING_API_KEY
  const hits = new Map<string, string[]>()
  if (!key || !urls.length) return hits
  try {
    const response = await fetch(`${SAFE_BROWSING}?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client: { clientId: 'mailbox', clientVersion: '1.0.0' },
        threatInfo: {
          threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: urls.map(url => ({ url })),
        },
      }),
    })
    if (!response.ok) return hits
    const data = (await response.json()) as { matches?: Array<{ threat?: { url?: string }; threatType?: string }> }
    for (const match of data.matches ?? []) {
      const url = match.threat?.url
      if (!url) continue
      const label = THREAT_LABEL[match.threatType ?? ''] ?? 'Flagged by Google Safe Browsing'
      hits.set(url, [...(hits.get(url) ?? []), label])
    }
  } catch {
    // Network/API failure must not block reading mail — fall back to heuristics.
  }
  return hits
}

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  let body: { links?: Array<{ url: string; text?: string }> }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const links = (body.links ?? []).filter(entry => entry?.url).slice(0, 100)
  if (!links.length) return NextResponse.json({ ok: true, results: {}, remoteEnabled: Boolean(process.env.SAFE_BROWSING_API_KEY) })

  const now = Date.now()
  const results: Record<string, { verdict: LinkVerdict; reasons: string[] }> = {}
  const needRemote: string[] = []

  for (const link of links) {
    const url = normalizeUrl(link.url.trim())
    const local = inspectUrl(url, link.text)
    const cached = cache.get(url)
    if (cached && now - cached.at < TTL_MS) {
      results[link.url] = { verdict: mergeVerdict(local.verdict, cached.verdict), reasons: [...new Set([...local.reasons, ...cached.reasons])] }
      continue
    }
    results[link.url] = { verdict: local.verdict, reasons: local.reasons }
    needRemote.push(url)
  }

  const remote = await lookupRemote(needRemote)
  for (const link of links) {
    const url = normalizeUrl(link.url.trim())
    const threats = remote.get(url)
    if (threats?.length) {
      results[link.url] = { verdict: 'dangerous', reasons: [...new Set([...(results[link.url]?.reasons ?? []), ...threats])] }
      cache.set(url, { verdict: 'dangerous', reasons: threats, at: now })
    } else if (needRemote.includes(url)) {
      cache.set(url, { verdict: 'safe', reasons: [], at: now })
    }
  }

  return NextResponse.json({ ok: true, results, remoteEnabled: Boolean(process.env.SAFE_BROWSING_API_KEY) })
}
