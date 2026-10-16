import { getObject, putObject } from './r2'
import { THUMB_WIDTH } from './thumb-size'

const SKIP = /\.(svg|ico)$/i
const SMALL_ENOUGH = 200 * 1024

export const thumbnailKey = (key: string) => `thumbs/${key}.w${THUMB_WIDTH}.webp`

/** Whether a stored file is worth a small copy: a raster image too big to show as it is. */
export function wantsThumbnail(file: { filename?: unknown; contentType?: unknown; size?: unknown } | undefined): boolean {
  if (!file) return false
  const name = String(file.filename ?? '')
  const type = String(file.contentType ?? '').toLowerCase()
  const image = type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|heic|heif)$/i.test(name)
  if (!image || SKIP.test(name) || type === 'image/svg+xml') return false
  const size = Number(file.size ?? 0)
  return !size || size > SMALL_ENOUGH
}

const thumbHeaders = (length: number) => ({
  'content-type': 'image/webp',
  'content-length': String(length),
  'cache-control': 'private, max-age=86400',
})

/** Makes and keeps the small copy of an image whose bytes are already in hand. */
export async function storeThumbnail(key: string, bytes: Buffer): Promise<Buffer | null> {
  try {
    const { default: sharp } = await import('sharp')
    const small = await sharp(bytes, { failOn: 'none', animated: false })
      .rotate()
      .resize({ width: THUMB_WIDTH, height: THUMB_WIDTH, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer()
    await putObject(thumbnailKey(key), small, 'image/webp').catch(() => false)
    return small
  } catch (err) {
    console.error('[mail] thumbnail failed for', key, err)
    return null
  }
}

/**
 * A small copy of a stored image, kept in the bucket beside the original and made on the
 * first request when arrival did not make it. Null when the bytes cannot be read or
 * decoded, so the caller can serve the original instead.
 */
export async function thumbnailResponse(key: string): Promise<Response | null> {
  const cached = await getObject(thumbnailKey(key)).catch(() => null)
  if (cached?.ok && cached.body) {
    const bytes = Buffer.from(await cached.arrayBuffer())
    return new Response(bytes, { headers: thumbHeaders(bytes.length) })
  }
  const original = await getObject(key).catch(() => null)
  if (!original?.ok) return null
  const small = await storeThumbnail(key, Buffer.from(await original.arrayBuffer()))
  return small ? new Response(new Uint8Array(small), { headers: thumbHeaders(small.length) }) : null
}
