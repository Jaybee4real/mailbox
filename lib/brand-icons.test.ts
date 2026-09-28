import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('app icons come from the tenant, or else the generic ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-'))
  const own = Buffer.from('tenant icon bytes')
  writeFileSync(join(dir, 'icon-192.png'), own)
  process.env.BRAND_ASSET_DIR = dir

  const { GET } = await import('../app/brand/[file]/route.ts')
  const fetchBrand = async (file: string) => {
    const response = await GET(new Request(`https://mail.example.com/brand/${file}`), { params: Promise.resolve({ file }) })
    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) }
  }
  const generic = (name: string) => readFileSync(join(process.cwd(), 'public', name))

  assert.deepEqual((await fetchBrand('icon-192.png')).bytes, own, 'a tenant icon wins')
  assert.deepEqual((await fetchBrand('icon-512.png')).bytes, generic('icon-512.png'))
  assert.deepEqual((await fetchBrand('icon-maskable-512.png')).bytes, generic('icon-maskable-512.png'))
  assert.deepEqual((await fetchBrand('apple-icon.png')).bytes, generic('icon-512.png'), 'the touch icon borrows the large one')
  assert.equal((await fetchBrand('mark.png')).status, 200, 'marks still get the placeholder')
  assert.equal((await fetchBrand('anything-else.png')).status, 404)
})
