import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const directory = mkdtempSync(join(tmpdir(), 'blocked-test-'))
process.env.DATABASE_URL = `file:${directory}/test.sqlite`
process.env.VELA_API_URL = 'https://vela.example.com'
process.env.VELA_API_KEY = 'vela_test'
after(() => rmSync(directory, { recursive: true, force: true }))

let checkCalls = 0
let velaAvailable = true
globalThis.fetch = async (input, init) => {
  const url = String(input)
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer vela_test')
  if (url === 'https://vela.example.com/api/v1/suppressions/check') {
    checkCalls += 1
    if (!velaAvailable) throw new Error('connect ECONNREFUSED')
    const asked = JSON.parse(String(init?.body)).addresses as string[]
    const known = [{ address: 'Dead@Example.com', reason: 'bounce', detail: 'Hard bounce', createdAt: '2026-10-01T00:00:00.000Z', shared: true }]
    return new Response(JSON.stringify({ data: known.filter(entry => asked.includes(entry.address.toLowerCase())) }))
  }
  if (url.startsWith('https://vela.example.com/api/v1/suppressions?address=')) return new Response(JSON.stringify({ still_blocked: null }))
  throw new Error(`unexpected fetch ${url}`)
}

test("addresses on Vela's shared list are refused before sending and remembered", async () => {
  const { blockedAmong, listBlocked, unblockAddress } = await import('./blocked.ts')
  const blocked = await blockedAmong(['Someone <dead@example.com>', 'fine@example.com'])
  assert.deepEqual(blocked.map(entry => [entry.address, entry.reason]), [['dead@example.com', 'bounce']])
  assert.ok((await listBlocked()).some(entry => entry.address === 'dead@example.com'))

  const callsBefore = checkCalls
  assert.equal((await blockedAmong(['dead@example.com'])).length, 1)
  assert.equal(checkCalls, callsBefore, 'a remembered address is answered locally')

  assert.equal(await unblockAddress('dead@example.com'), null)
  assert.ok(!(await listBlocked()).some(entry => entry.address === 'dead@example.com'))
})

test('an unreachable Vela never blocks a send on its own', async () => {
  const { blockedAmong } = await import('./blocked.ts')
  velaAvailable = false
  assert.deepEqual(await blockedAmong(['new-person@example.com']), [])
})
