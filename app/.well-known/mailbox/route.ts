import { NextResponse } from 'next/server'
import { ADDRESS_DOMAINS, BRAND } from '@/lib/brand'
import { CLIENT_BRAND } from '@/lib/brand.client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Public deployment identity only. Never disclose seats or registered email addresses. */
export async function GET() {
  const identity = {
    name: BRAND.name, domain: BRAND.domain,
    domains: [...new Set([...ADDRESS_DOMAINS, ...CLIENT_BRAND.addressDomains])],
    baseUrl: BRAND.publicUrl,
    accent: BRAND.accentHex,
    logo: new URL(BRAND.chromeMarkUrl, BRAND.publicUrl).href,
  }
  return NextResponse.json({
    protocol: 'novacraft-mailbox', version: 1,
    ...identity,
    workspace: identity,
    capabilities: ['bearer-session', 'threads', 'search', 'scheduled', 'stash', 'workspace', 'passkeys'],
  }, { headers: { 'Cache-Control': 'public, max-age=300' } })
}
