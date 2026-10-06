import assert from 'node:assert/strict'
import test from 'node:test'

test('mobile discovery uses tenant server branding and includes alternate address domains', async () => {
  process.env.BRAND_NAME = 'Test Workspace'
  process.env.MAIL_ADDRESS_DOMAIN = 'workspace.test'
  process.env.MAIL_DEFAULT_ADDRESS_DOMAIN = 'contact.workspace.test'
  process.env.MAIL_ADDRESS_DOMAINS = 'support.workspace.test,workspace.test'
  process.env.NEXT_PUBLIC_MAIL_ADDRESS_DOMAINS = 'public.workspace.test'
  process.env.MAIL_PUBLIC_URL = 'https://mail.workspace.test'
  process.env.BRAND_ACCENT_HEX = '#123456'
  process.env.BRAND_CHROME_MARK_URL = '/brand/mark.png'
  process.env.NEXT_PUBLIC_MAIL_PUBLIC_URL = 'https://outdated.test'
  process.env.NEXT_PUBLIC_BRAND_ACCENT = '#abcdef'

  const { GET } = await import('../app/.well-known/mailbox/route.ts')
  const response = await GET()
  assert.equal(response.status, 200)
  const identity = await response.json()
  assert.equal(identity.protocol, 'novacraft-mailbox')
  assert.equal(identity.version, 1)
  assert.equal(identity.name, 'Test Workspace')
  assert.equal(identity.baseUrl, 'https://mail.workspace.test')
  assert.equal(identity.accent, '#123456')
  assert.equal(identity.logo, 'https://mail.workspace.test/brand/mark.png')
  assert.deepEqual(new Set(identity.domains), new Set([
    'workspace.test', 'contact.workspace.test', 'support.workspace.test', 'public.workspace.test',
  ]))
  assert.ok(identity.capabilities.includes('bearer-session'))
  assert.equal(identity.seats, undefined)
  assert.equal(identity.addresses, undefined)
});
