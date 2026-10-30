import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanCode, cleanEmail, deepLink, readDeepLink, spacedCode } from './deep-links.ts'

test('links go only to the fixed screens on the mailbox origin, with clean parameters', () => {
  assert.equal(deepLink('https://mail.example.com', 'signin', { email: 'Ada@Example.com', code: '123 456' }), 'https://mail.example.com/mail/signin?email=ada%40example.com&code=123456')
  assert.equal(deepLink('https://mail.example.com', 'forgot', { email: 'ada@example.com' }), 'https://mail.example.com/mail/forgot?email=ada%40example.com')
  assert.equal(deepLink('https://mail.example.com', 'security'), 'https://mail.example.com/mail/security')
  assert.equal(deepLink('https://mail.example.com', 'signin', { email: 'not an email', code: '12345' }), 'https://mail.example.com/mail/signin')
})

test('a link is read only on its own path, and every parameter is validated', () => {
  assert.deepEqual(readDeepLink('/mail/signin', '?email=ada%40example.com&code=123456'), { target: 'signin', email: 'ada@example.com', code: '123456' })
  assert.deepEqual(readDeepLink('/mail/signin/', '?email=<script>&code=12a456'), { target: 'signin', email: null, code: null })
  assert.deepEqual(readDeepLink('/mail/forgot', '?email=ada%40example.com&code=123456'), { target: 'forgot', email: 'ada@example.com', code: null }, 'a reset link never carries a code')
  assert.deepEqual(readDeepLink('/mail/security', '?email=ada%40example.com&code=654321&next=https://evil.example'), { target: 'security', email: null, code: '654321' })
  assert.equal(readDeepLink('/mail', '?email=ada%40example.com'), null)
  assert.equal(readDeepLink('/mail/reset', '?token=abc'), null)
  assert.equal(readDeepLink('/mail/../admin', ''), null)
})

test('emails and codes are checked strictly', () => {
  assert.equal(cleanEmail(' Ada.Lovelace+mail@Example.co.uk '), 'ada.lovelace+mail@example.co.uk')
  for (const bad of ['ada', 'ada@', '@example.com', 'ada@example', 'a b@example.com', 'ada@example.com\nBcc: x@y.z', `${'a'.repeat(65)}@example.com`, 42, null]) assert.equal(cleanEmail(bad), null, String(bad))
  assert.equal(cleanCode('123-456'), '123456')
  for (const bad of ['12345', '1234567', '12345a', '', undefined]) assert.equal(cleanCode(bad), null, String(bad))
  assert.equal(spacedCode('123456'), '123 456')
})
