import { NextResponse } from 'next/server'
import { DEEP_LINK_PATHS } from '@/lib/deep-links'
import { VELA_IOS_APP_IDS } from '@/lib/passkeys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json({
    applinks: {
      details: [{
        appIDs: VELA_IOS_APP_IDS,
        components: Object.values(DEEP_LINK_PATHS).map(path => ({ '/': path })),
      }],
    },
    webcredentials: { apps: VELA_IOS_APP_IDS },
  }, { headers: { 'Cache-Control': 'public, max-age=3600' } })
}
