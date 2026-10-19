import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { bodyCacheEnabled, bodyCacheFull, cachedBody, isBodyCached, storeBody } from './body-cache.ts'

const noise = (bytes: number) => randomBytes(bytes).toString('base64')
const fileFor = (root: string, key: string) => {
  const digest = createHash('sha1').update(key).digest('hex')
  return join(root, digest.slice(0, 2), `${digest}.html.gz`)
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'body-cache-'))
  process.env.BODY_CACHE_DIR = dir

  assert.equal(bodyCacheEnabled(), true)
  assert.equal(await cachedBody('bodies/missing.html'), null)
  assert.equal(await isBodyCached('bodies/missing.html'), false)

  const html = '<p>Héllo — an imported message</p>'.repeat(200)
  await storeBody('bodies/one.html', html)
  assert.equal(await isBodyCached('bodies/one.html'), true)
  assert.equal(await cachedBody('bodies/one.html'), html, 'a stored body reads back byte for byte')
  assert.equal(await bodyCacheFull(), false)

  process.env.BODY_CACHE_MAX_MB = String(40_000 / (1024 * 1024))
  await storeBody('bodies/huge.html', noise(20_000))
  assert.equal(await isBodyCached('bodies/huge.html'), false, 'one body may not take more than a tenth of the budget')

  const old = new Date(Date.now() - 60_000)
  for (let index = 0; index < 20; index += 1) {
    await storeBody(`bodies/n${index}.html`, noise(2_400))
    utimesSync(fileFor(dir, `bodies/n${index}.html`), old, new Date(old.getTime() + index * 1000))
  }
  await new Promise(resolve => setTimeout(resolve, 50))
  await storeBody('bodies/latest.html', noise(2_400))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await isBodyCached('bodies/latest.html'), true, 'the newest body stays')
  assert.equal(await isBodyCached('bodies/n0.html'), false, 'the least recently read body is evicted first')
  assert.equal(await bodyCacheFull(), true)

  delete process.env.BODY_CACHE_DIR
  process.env.DATABASE_URL = 'libsql://example.turso.io'
  assert.equal(bodyCacheEnabled(), false, 'a remote database has no local disk to cache on')
  assert.equal(await cachedBody('bodies/one.html'), null)

  rmSync(dir, { recursive: true, force: true })
  console.log('body cache ok')
}

void main()
