import assert from 'node:assert/strict'
import test from 'node:test'

process.env.MAIL_ADDRESS_DOMAIN = 'contact.example.com'
process.env.MAIL_ADDRESS_DOMAINS = 'example.com,contact.example.com'

test('every domain we receive on is refused as a forward target, not just the primary one', async () => {
  const { ADDRESS_DOMAINS } = await import('./brand.ts')
  const loops = (address: string) => ADDRESS_DOMAINS.includes(address.split('@')[1] ?? '')
  assert.equal(loops('hosting@example.com'), true, 'a secondary domain we receive on would loop')
  assert.equal(loops('hello@contact.example.com'), true, 'the primary domain would loop')
  assert.equal(loops('someone@gmail.com'), false, 'an outside address is a real destination')
})
