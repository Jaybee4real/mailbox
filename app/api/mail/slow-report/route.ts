import { mailAuthGuard } from '@/lib/dev-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const body = (await req.json().catch(() => null)) as { path?: unknown; ms?: unknown } | null
  const path = typeof body?.path === 'string' ? body.path.split('?')[0].slice(0, 120) : ''
  const ms = Number(body?.ms)
  if (path.startsWith('/api/') && Number.isFinite(ms) && ms > 0 && ms < 600_000) {
    console.warn(`[mail] slow request ${path} ${Math.round(ms)}ms (reader's connection was fine)`)
  }
  return new Response(null, { status: 204 })
}
