import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(
    {
      sha: process.env.NEXT_PUBLIC_BUILD_SHA || null,
      number: process.env.NEXT_PUBLIC_BUILD_NUMBER || null,
      version: process.env.NEXT_PUBLIC_APP_VERSION || null,
      builtAt: process.env.NEXT_PUBLIC_BUILD_TIME || null,
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
