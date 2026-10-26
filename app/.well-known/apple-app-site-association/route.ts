import { NextResponse } from 'next/server'
import { VELA_IOS_APP_IDS } from '@/lib/passkeys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json({ webcredentials: { apps: VELA_IOS_APP_IDS } }, { headers: { 'Cache-Control': 'public, max-age=3600' } })
}
