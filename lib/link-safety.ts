export type LinkVerdict = 'safe' | 'suspicious' | 'dangerous' | 'unknown'

export type LinkFinding = {
  url: string
  verdict: LinkVerdict
  reasons: string[]
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'()]+[^\s<>"'().,;:!?]/gi

// Free hosts and shorteners that hide the real destination.
const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly',
  'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'lnkd.in', 'bit.do', 't.ly',
])

// TLDs disproportionately used for throwaway phishing domains.
const RISKY_TLDS = new Set(['zip', 'mov', 'tk', 'ml', 'ga', 'cf', 'gq', 'top', 'xyz', 'click', 'link', 'work', 'country', 'kim'])

export function extractUrls(text: string): string[] {
  const found = text.match(URL_RE) ?? []
  return Array.from(new Set(found.map(entry => (entry.startsWith('www.') ? `https://${entry}` : entry))))
}

export function normalizeUrl(raw: string): string {
  return raw.startsWith('www.') ? `https://${raw}` : raw
}

/** Offline checks — catch the common email-phishing shapes with no network call. */
export function inspectUrl(raw: string, anchorText?: string): LinkFinding {
  const url = normalizeUrl(raw.trim())
  const reasons: string[] = []
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { url, verdict: 'unknown', reasons: ['Malformed URL'] }
  }

  const host = parsed.hostname.toLowerCase()

  if (parsed.protocol === 'http:') reasons.push('Unencrypted connection (http)')
  if (parsed.username || parsed.password) reasons.push('Credentials embedded in the URL')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) reasons.push('Raw IP address instead of a domain')
  if (host.startsWith('xn--') || host.includes('.xn--')) reasons.push('Punycode domain — may impersonate another brand')
  if (SHORTENERS.has(host)) reasons.push('Shortened link — real destination is hidden')

  const tld = host.split('.').pop() ?? ''
  if (RISKY_TLDS.has(tld)) reasons.push(`High-risk domain ending (.${tld})`)
  if (host.split('.').length > 4) reasons.push('Unusually deep subdomain chain')
  if (parsed.href.length > 300) reasons.push('Excessively long URL')

  // The strongest email-phishing signal: the visible text claims one destination,
  // the href points somewhere else.
  if (anchorText) {
    const claimed = anchorText.match(/\b(?:https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,})\b/i)?.[1]?.toLowerCase()
    if (claimed) {
      const claimedRoot = claimed.split('.').slice(-2).join('.')
      const actualRoot = host.split('.').slice(-2).join('.')
      if (claimedRoot !== actualRoot) {
        reasons.push(`Link text says "${claimedRoot}" but points to ${actualRoot}`)
      }
    }
  }

  const severe = reasons.some(
    reason =>
      reason.startsWith('Link text says') ||
      reason.startsWith('Credentials') ||
      reason.startsWith('Raw IP') ||
      reason.startsWith('Punycode'),
  )
  if (severe) return { url, verdict: 'dangerous', reasons }
  if (reasons.length) return { url, verdict: 'suspicious', reasons }
  return { url, verdict: 'safe', reasons }
}

export function mergeVerdict(local: LinkVerdict, remote: LinkVerdict): LinkVerdict {
  const rank: Record<LinkVerdict, number> = { safe: 0, unknown: 1, suspicious: 2, dangerous: 3 }
  return rank[remote] >= rank[local] ? remote : local
}
