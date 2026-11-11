import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const directory = mkdtempSync(join(tmpdir(), 'accessor-invite-test-'))
process.env.DATABASE_URL = `file:${directory}/test.sqlite`
process.env.MAIL_ADDRESS_DOMAIN = 'example.com'
process.env.MAIL_SEATS = '[]'
process.env.MAIL_SESSION_SECRET = 'test-session-secret'
after(() => rmSync(directory, { recursive: true, force: true }))

let outboundRequests = 0
globalThis.fetch = async () => {
  outboundRequests += 1
  throw new Error('no network in this test')
}

test('an invite to a disposable address is refused before any account is created or mail is sent', async () => {
  const mailbox = await import('./mailbox.ts')
  const { issueSession, passwordFingerprint, SESSION_COOKIE } = await import('./session.ts')
  const { POST } = await import('../app/api/mail/accessors/route.ts')

  await mailbox.createAccount({ email: 'admin@example.com', address: 'admin@example.com', role: 'admin', status: 'active' })
  const cookie = `${SESSION_COOKIE}=${issueSession('admin@example.com', passwordFingerprint(undefined))}`
  const accountsBefore = (await mailbox.listAccounts()).length

  const response = await POST(new Request('https://mail.example.com/api/mail/accessors', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ email: 'Check@Mailinator.com', name: 'Check' }),
  }))

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { ok: false, error: "Please use a permanent email address. Disposable email addresses aren't accepted." })
  assert.equal(await mailbox.getAccount('check@mailinator.com'), null)
  assert.equal((await mailbox.listAccounts()).length, accountsBefore)
  assert.equal(outboundRequests, 0)
})
