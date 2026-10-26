import { NextResponse } from 'next/server'
import { VELA_ANDROID_CERTS, VELA_ANDROID_PACKAGE } from '@/lib/passkeys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json([{
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: { namespace: 'android_app', package_name: VELA_ANDROID_PACKAGE, sha256_cert_fingerprints: VELA_ANDROID_CERTS },
  }], { headers: { 'Cache-Control': 'public, max-age=3600' } })
}
