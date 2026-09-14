import { markPixelOpened } from '@/lib/mailbox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (id) await markPixelOpened(id).catch(() => {})
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
