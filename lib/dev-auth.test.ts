import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

process.env.DATABASE_URL = 'file::memory:'
process.env.MAIL_ADDRESS_DOMAIN = 'example.com'
process.env.MAIL_SEATS = '[]'
process.env.DEV_ADMIN_EMAIL_HASH = createHash('sha256').update('operator@elsewhere.com').digest('hex')
process.env.DEV_ADMIN_PASSWORD_HASH = createHash('sha256').update('master-password').digest('hex')

test('the env credential is not a tenant-wide master key', async () => {
  const { verifyMailAuth } = await import('./dev-auth.ts')
  const result = await verifyMailAuth('operator@elsewhere.com', 'master-password')
  assert.equal(result.ok, false, 'it opens no address this deployment does not host')
})
