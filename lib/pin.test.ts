import assert from 'node:assert/strict'
import test from 'node:test'

process.env.DATABASE_URL = 'file::memory:'
process.env.MAIL_ADDRESS_DOMAIN = 'example.com'
process.env.MAIL_SEATS = '[]'
process.env.MAIL_SESSION_SECRET = 'pin-test-secret'

test('a PIN verifies only with the same digits and the same server secret', async () => {
  const { hashPin, verifyPin } = await import('./pin.ts')
  const stored = hashPin('482915')
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
  assert.equal(verifyPin('482915', stored), true)
  assert.equal(verifyPin('482916', stored), false)
  assert.equal(verifyPin('48291', stored), false)
  assert.equal(verifyPin('abcdef', stored), false)
  assert.equal(verifyPin('482915', null), false)
  process.env.MAIL_SESSION_SECRET = 'another-secret'
  assert.equal(verifyPin('482915', stored), false)
  process.env.MAIL_SESSION_SECRET = 'pin-test-secret'
})

test('five wrong PINs lock the account until a sign-in clears it', async () => {
  const { createAccount, pinState, savePin, recordPinAttempt, clearPinLock } = await import('./mailbox.ts')
  const { hashPin } = await import('./pin.ts')
  await createAccount({ email: 'pin@example.com', password: 'a-long-password-1', role: 'member', address: 'pin@example.com' })
  await savePin('pin@example.com', hashPin('123456'))
  assert.deepEqual((await pinState('pin@example.com')).set, true)
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await recordPinAttempt('pin@example.com', false, 5)
    assert.equal(result.locked, false)
    assert.equal(result.failed, attempt)
  }
  assert.equal((await recordPinAttempt('pin@example.com', false, 5)).locked, true)
  await clearPinLock('pin@example.com')
  const cleared = await pinState('pin@example.com')
  assert.equal(cleared.locked, false)
  assert.equal(cleared.failed, 0)
  assert.equal(cleared.set, true)
  await savePin('pin@example.com', null)
  assert.equal((await pinState('pin@example.com')).set, false)
})
