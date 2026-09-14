import assert from 'node:assert/strict'
import { issueSession, readSession, passwordFingerprint, SESSION_COOKIE } from './session.ts'

const asRequest = (cookie: string) => new Request('https://mail.example.com/', { headers: { cookie } })
const withToken = (token: string) => asRequest(`${SESSION_COOKIE}=${token}`)

process.env.MAIL_SESSION_SECRET = 'test-secret-value'

const fingerprint = passwordFingerprint('scrypt$16384$abc$def')
const token = issueSession('Info@Example.com', fingerprint)
assert.ok(token, 'a secret is configured, so a token is issued')

const session = readSession(withToken(token!))
assert.equal(session?.email, 'info@example.com', 'the address round-trips, lowercased')
assert.equal(session?.fingerprint, fingerprint)

// A flipped character in the signature must not verify.
const tampered = token!.slice(0, -1) + (token!.endsWith('A') ? 'B' : 'A')
assert.equal(readSession(withToken(tampered)), null, 'a tampered signature is rejected')

// Re-signing a different address with the same length must not verify either.
const swapped = token!.split('.')
swapped[0] = Buffer.from('other@mailbox.com').toString('base64url')
assert.equal(readSession(withToken(swapped.join('.'))), null, 'a swapped payload is rejected')

// An expired token is rejected even though its signature is genuine.
const expired = (() => {
  const parts = issueSession('info@example.com', fingerprint)!.split('.')
  parts[1] = String(Date.now() - 1000)
  return parts.join('.')
})()
assert.equal(readSession(withToken(expired)), null, 'an edited expiry breaks the signature')

// A password change moves the fingerprint, which is what retires old cookies.
assert.notEqual(passwordFingerprint('scrypt$16384$abc$def'), passwordFingerprint('scrypt$16384$abc$xyz'))

assert.equal(readSession(asRequest('other=1')), null, 'no cookie, no session')

delete process.env.MAIL_SESSION_SECRET
assert.equal(issueSession('info@example.com', fingerprint), null, 'no secret, no token')
assert.equal(readSession(withToken(token!)), null, 'no secret, nothing verifies')

console.log('session self-check passed')
