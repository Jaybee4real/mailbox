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

test('the To line comes from the header, not from the copy the provider delivered', async () => {
  const { headerAddresses } = await import('./receive.ts')

  assert.deepEqual(
    headerAddresses('eric.samuel@coronationinsurance.com.ng, sijuatobatele@lasacoassurance.com'),
    ['eric.samuel@coronationinsurance.com.ng', 'sijuatobatele@lasacoassurance.com'],
  )
  assert.deepEqual(
    headerAddresses('"Adeolu Ajao" <aajao@custodianinsurance.com>, "Ernest Okpata" <eokpata.metroperil@gmail.com>'),
    ['aajao@custodianinsurance.com', 'eokpata.metroperil@gmail.com'],
  )
  assert.deepEqual(headerAddresses('"Doe, John" <john@example.com>, jane@example.com'), ['john@example.com', 'jane@example.com'], 'a comma inside a quoted name does not split it')
  assert.deepEqual(headerAddresses('"Say \\"hi\\", please" <quote@example.com>'), ['quote@example.com'], 'an escaped quote does not end the name')
  assert.deepEqual(headerAddresses('undisclosed-recipients:;'), [], 'a blind copy has no visible recipient')
  assert.deepEqual(headerAddresses('team: a@example.com, b@example.com;'), ['a@example.com', 'b@example.com'])
  assert.deepEqual(headerAddresses(['a@example.com', '"B" <b@example.com>']), ['a@example.com', 'b@example.com'])
  assert.deepEqual(headerAddresses('john@x.com (John)'), ['john@x.com'], 'a trailing comment is not part of the address')
  assert.deepEqual(headerAddresses('john@x.com (Smith, John), k@x.com'), ['john@x.com', 'k@x.com'], 'a comma inside a comment does not split')
  assert.deepEqual(headerAddresses('"Ops <ops@old.com>" <real@x.com>, k@x.com'), ['real@x.com', 'k@x.com'], 'brackets inside a quoted name are not the address')
  assert.deepEqual(headerAddresses('Jo (a "b) <j@x.com>, k@x.com'), ['j@x.com', 'k@x.com'])
  assert.deepEqual(headerAddresses(undefined), [])
  assert.deepEqual(headerAddresses(''), [])
})
