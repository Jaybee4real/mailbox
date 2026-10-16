import assert from 'node:assert/strict'
import { thumbnailKey, wantsThumbnail } from './thumbnail.ts'

assert.equal(wantsThumbnail({ filename: 'IMG_1.jpg', contentType: 'image/jpeg', size: 4_444_592 }), true, 'a phone photo gets a small copy')
assert.equal(wantsThumbnail({ filename: 'scan', contentType: 'image/png', size: 900_000 }), true, 'the declared type answers for a bare name')
assert.equal(wantsThumbnail({ filename: 'icon.png', contentType: 'image/png', size: 1207 }), false, 'a small image is served as it is')
assert.equal(wantsThumbnail({ filename: 'logo.svg', contentType: 'image/svg+xml', size: 900_000 }), false, 'vectors are left alone')
assert.equal(wantsThumbnail({ filename: 'report.pdf', contentType: 'application/pdf', size: 4_000_000 }), false)
assert.equal(wantsThumbnail(undefined), false)
assert.equal(thumbnailKey('attachments/m1/0-a b.jpg'), 'thumbs/attachments/m1/0-a b.jpg.w480.webp')

async function main() {
  const { storeThumbnail } = await import('./thumbnail.ts')
  const { default: sharp } = await import('sharp')
  const photo = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#3a6' } }).jpeg().toBuffer()
  const small = await storeThumbnail('attachments/test/0-photo.jpg', photo)
  assert.ok(small, 'the copy is made even when the bucket write fails')
  const meta = await sharp(small!).metadata()
  assert.equal(meta.format, 'webp')
  assert.ok(meta.width === 480 && meta.height === 360, `fits a 480 box, kept its shape (${meta.width}x${meta.height})`)
  assert.ok(small!.length < photo.length / 5)
  console.log('thumbnail: ok')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
