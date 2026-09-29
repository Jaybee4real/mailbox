import assert from 'node:assert/strict'
import { base32Decode, base32Encode, describeDevice, hashEmailCode, maskEmail, newTotpSecret, otpauthUri, totpAt, verifyTotp } from './two-factor.ts'

const rfcSecret = base32Encode(Buffer.from('12345678901234567890'))
assert.equal(rfcSecret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
assert.equal(base32Decode(rfcSecret).toString(), '12345678901234567890')

// RFC 6238 appendix B, SHA-1 vectors, last six digits.
assert.equal(totpAt(rfcSecret, 59_000), '287082')
assert.equal(totpAt(rfcSecret, 1_111_111_109_000), '081804')
assert.equal(totpAt(rfcSecret, 1_234_567_890_000), '005924')
assert.equal(totpAt(rfcSecret, 2_000_000_000_000), '279037')

const now = 1_790_000_000_000
const secret = newTotpSecret()
assert.equal(secret.length, 32)
assert.ok(verifyTotp(secret, totpAt(secret, now), now))
assert.ok(verifyTotp(secret, totpAt(secret, now - 30_000), now), 'a code from the previous step still works')
assert.ok(verifyTotp(secret, totpAt(secret, now + 30_000), now), 'a phone running a step fast still works')
assert.ok(!verifyTotp(secret, totpAt(secret, now - 90_000), now), 'an old code does not')
assert.ok(verifyTotp(secret, totpAt(secret, now).replace(/(\d{3})/, '$1 '), now), 'a space typed mid-code is fine')
assert.ok(!verifyTotp(secret, '12345', now) && !verifyTotp('', '123456', now))

assert.notEqual(hashEmailCode('a', '123456'), hashEmailCode('b', '123456'), 'codes are bound to their challenge')
assert.equal(hashEmailCode('a', '123 456'), hashEmailCode('a', '123456'))
assert.equal(maskEmail('kindness@gmail.com'), 'k••••••@gmail.com')
assert.match(otpauthUri('info@example.com', 'Example Mail', secret), /^otpauth:\/\/totp\/Example%20Mail%3Ainfo%40example\.com\?secret=[A-Z2-7]{32}&issuer=Example%20Mail/)
assert.equal(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'), 'Chrome on macOS')
assert.equal(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari on iOS')
assert.equal(describeDevice('curl/8.7.1'), 'Script')

console.log('two-factor: ok')
