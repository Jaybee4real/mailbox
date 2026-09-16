import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { NextResponse } from 'next/server'
import { PLACEHOLDER_MARK } from './placeholder'

export const runtime = 'nodejs'

const DIR = process.env.BRAND_ASSET_DIR ?? '/data/brand'

const PLACEHOLDER_FILES = new Set(['mark.png', 'mark-email.png', 'logo.png'])

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

/**
 * A tenant's own images, read from the volume rather than the repository, so the codebase
 * carries no brand. Public by design: a recipient's mail client fetches the mark in a
 * signature with no session, from wherever in the world they open the message.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) return new NextResponse('Not found', { status: 404 })
  const type = TYPES[extname(file).toLowerCase()]
  if (!type) return new NextResponse('Not found', { status: 404 })
  try {
    const bytes = await readFile(join(DIR, file))
    return new NextResponse(new Uint8Array(bytes), {
      headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' },
    })
  } catch {
    if (!PLACEHOLDER_FILES.has(file)) return new NextResponse('Not found', { status: 404 })
    return new NextResponse(new Uint8Array(PLACEHOLDER_MARK), {
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
    })
  }
}
