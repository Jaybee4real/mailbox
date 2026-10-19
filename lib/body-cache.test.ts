import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bodyCacheEnabled, cachedBody, isBodyCached, storeBody } from './body-cache.ts'

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
  assert.equal(await cachedBody('bodies/two.html'), null)

  delete process.env.BODY_CACHE_DIR
  process.env.DATABASE_URL = 'libsql://example.turso.io'
  assert.equal(bodyCacheEnabled(), false, 'a remote database has no local disk to cache on')
  assert.equal(await cachedBody('bodies/one.html'), null)

  process.env.DATABASE_URL = 'file:/data/mail.db'
  assert.equal(bodyCacheEnabled(), true)

  rmSync(dir, { recursive: true, force: true })
  console.log('body cache ok')
}

void main()
