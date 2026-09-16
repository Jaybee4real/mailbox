import { BRAND } from '@/lib/brand'
import { markPixelOpened } from '@/lib/mailbox'
import { readSession } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** A signed-in user of this mailbox, or a page of it, looking at their own mail is not a recipient opening it. */
function ownView(req: Request): boolean {
  if (readSession(req)) return true
  const referer = req.headers.get('referer')
  if (!referer) return false
  const ownHost = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').split(',')[0].trim().toLowerCase()
  try {
    const host = new URL(referer).host.toLowerCase()
    return host === ownHost || (Boolean(BRAND.publicUrl) && host === new URL(BRAND.publicUrl).host.toLowerCase())
  } catch {
    return false
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (id && !ownView(req)) await markPixelOpened(id).catch(() => {})
  return new Response(PIXEL, {
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(PIXEL.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  })
}
