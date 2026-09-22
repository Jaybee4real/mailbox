import assert from 'node:assert/strict'

process.env.MAIL_ADDRESS_DOMAIN = 'metroperilinsbrokers.com'
process.env.MAIL_ADDRESS_DOMAINS = 'metroperilinsbrokers.com'

import test from 'node:test'

test('only mail addressed to a hosted domain is ingested', async () => {
  const { addressedToUs } = await import('./receive.ts')

  assert.equal(addressedToUs(['info@metroperilinsbrokers.com']), true)
  assert.equal(addressedToUs(['O. Komolafe <okomolafe@metroperilinsbrokers.com>']), true, 'a display name does not hide the domain')
  assert.equal(addressedToUs(['someone@example.com', 'info@metroperilinsbrokers.com']), true, 'one of ours is enough')

  // The leak: one provider account held several tenants' domains and posted all of their
  // mail to this one webhook, which filed it to the shared inbox because no local account
  // matched. 360 of another tenant's messages became readable here.
  assert.equal(addressedToUs(['hello@contact.novacraft.africa']), false)
  assert.equal(addressedToUs(['admin@jakstoc.com', 'info@podzyme.com']), false)
  assert.equal(addressedToUs([]), false, 'no recipient is not our recipient')
  // A domain that merely ends with ours is a different domain.
  assert.equal(addressedToUs(['x@evil-metroperilinsbrokers.com']), false)
  assert.equal(addressedToUs(['x@metroperilinsbrokers.com.evil.net']), false)

})
