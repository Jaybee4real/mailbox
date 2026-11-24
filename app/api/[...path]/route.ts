import { notFound } from 'next/navigation'
import { authenticate } from '@/lib/dev-auth'
import { isWatched, reportSecurityEvent } from '@/lib/security-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function unknownRoute(req: Request): Promise<never> {
  const path = new URL(req.url).pathname
  if (isWatched(path)) {
    const viewer = await authenticate(req).catch(() => null)
    if (viewer) void reportSecurityEvent(req, { level: 2, kind: 'decoy-route', detail: `${req.method} ${path} by ${viewer}` })
  }
  notFound()
}

export { unknownRoute as GET, unknownRoute as POST, unknownRoute as PUT, unknownRoute as PATCH, unknownRoute as DELETE }
