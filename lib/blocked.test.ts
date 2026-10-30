import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const directory = mkdtempSync(join(tmpdir(), 'blocked-test-'))
process.env.DATABASE_URL = `file:${directory}/test.sqlite`
process.env.SES_ACCESS_KEY_ID = 'test-key'
process.env.SES_SECRET_ACCESS_KEY = 'test-secret'
delete process.env.RESEND_BASE_URL
delete process.env.RESEND_API_KEY
after(() => rmSync(directory, { recursive: true, force: true }))

let sesListCalls = 0
let sesAvailable = true
globalThis.fetch = async input => {
  const url = String(input)
  if (url.includes('/v2/email/suppression/addresses')) {
    sesListCalls += 1
    if (!sesAvailable) return new Response(JSON.stringify({ message: 'Rate exceeded' }), { status: 429 })
    return new Response(JSON.stringify({
      SuppressedDestinationSummaries: [
        { EmailAddress: 'Dead@Example.com', Reason: 'BOUNCE', LastUpdateTime: 1793000000 },
        { EmailAddress: 'angry@example.com', Reason: 'COMPLAINT', LastUpdateTime: 1793000000 },
      ],
    }))
  }
  throw new Error(`unexpected fetch ${url}`)
}

test('addresses on the SES suppression list are refused before sending and remembered', async () => {
  const { blockedAmong, listBlocked, unblockAddress } = await import('./blocked.ts')

  const blocked = await blockedAmong(['Someone <dead@example.com>', 'fine@example.com', 'angry@example.com'])
  assert.deepEqual(
    blocked.map(entry => [entry.address, entry.reason]).sort(),
    [['angry@example.com', 'complaint'], ['dead@example.com', 'bounce']],
  )
  assert.equal(sesListCalls, 1)

  const remembered = await listBlocked()
  assert.ok(remembered.some(entry => entry.address === 'dead@example.com' && entry.detail === 'On Amazon SES suppression list'))

  assert.deepEqual(await blockedAmong(['fine@example.com', 'other@example.com']), [])
  assert.equal(sesListCalls, 1, 'the SES list is cached rather than fetched for every check')

  await unblockAddress('dead@example.com')
  assert.deepEqual(await blockedAmong(['dead@example.com']), [], 'an admin unblock clears the cached SES entry too')
})

test('an unreachable SES never blocks a send on its own', async () => {
  const blocked = await import('./blocked.ts')
  sesAvailable = false
  const realNow = Date.now
  Date.now = () => realNow() + 11 * 60 * 1000
  try {
    const callsBefore = sesListCalls
    assert.deepEqual(await blocked.blockedAmong(['new-person@example.com']), [])
    assert.equal(sesListCalls, callsBefore + 1, 'a stale list is refreshed, and a failed refresh falls back instead of blocking')
  } finally {
    Date.now = realNow
  }
})
