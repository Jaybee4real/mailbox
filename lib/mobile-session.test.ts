import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { issueMobileSession, readMobileSession, mobileDevices, revokeMobileDevice, setMobilePush, mobilePushRecipients } from './mobile-session'
import { tursoQuery } from './turso'

test('mobile sessions are hashed, scoped, expiring and independently revocable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vela-session-test-'))
  process.env.DATABASE_URL = `file:${directory}/test.sqlite`
  try {
    const alice = await issueMobileSession('alice@example.com', 'fingerprint-a', 'Alice iPhone')
    const bob = await issueMobileSession('bob@example.com', 'fingerprint-b', 'Bob Android')
    const req = (token: string) => new Request('https://mail.example.com', { headers: { authorization: `Bearer ${token}` } })
    const session = await readMobileSession(req(alice))
    assert.equal(session?.email, 'alice@example.com')
    const rows = await tursoQuery('SELECT * FROM mail_mobile_sessions')
    assert.equal(rows.length, 2)
    assert.ok(rows.every(row => !Object.values(row).includes(alice) && !Object.values(row).includes(bob)), 'raw bearer tokens never enter the database')
    assert.equal((await mobileDevices('alice@example.com')).length, 1)
    await revokeMobileDevice('bob@example.com', session!.id)
    assert.ok(await readMobileSession(req(alice)), 'another owner cannot revoke Alice')
    await setMobilePush('bob@example.com', session!.id, 'fcm-wrong-device-token-12345')
    assert.equal((await mobilePushRecipients('alice@example.com')).length, 0)
    await setMobilePush('alice@example.com', session!.id, 'fcm-alice-device-token-12345')
    assert.equal((await mobilePushRecipients('alice@example.com')).length, 1)
    await revokeMobileDevice('alice@example.com', session!.id)
    assert.equal(await readMobileSession(req(alice)), null)
    assert.ok(await readMobileSession(req(bob)))
    await tursoQuery('UPDATE mail_mobile_sessions SET expires_at = 0')
    assert.equal(await readMobileSession(req(bob)), null)
    assert.equal(await readMobileSession(req('vm_invalid')), null)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
