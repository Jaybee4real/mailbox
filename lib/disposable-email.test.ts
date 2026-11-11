import assert from 'node:assert/strict'
import test from 'node:test'
import { isDisposableEmail } from './disposable-email.ts'

test('listed domains and their subdomains are disposable, case and spacing ignored', () => {
  assert.equal(isDisposableEmail('check@mailinator.com'), true)
  assert.equal(isDisposableEmail('  Check@MAILINATOR.com '), true)
  assert.equal(isDisposableEmail('check@inbox.mailinator.com'), true)
  assert.equal(isDisposableEmail('odd"@name"@mailinator.com'), true)
})

test('permanent providers and malformed input are not disposable', () => {
  assert.equal(isDisposableEmail('someone@gmail.com'), false)
  assert.equal(isDisposableEmail('someone@example.com'), false)
  assert.equal(isDisposableEmail('mailinator.com'), false)
  assert.equal(isDisposableEmail('someone@'), false)
  assert.equal(isDisposableEmail('someone@com'), false)
})
