import assert from 'node:assert/strict'
import test from 'node:test'
import { activeProvider, providerConfigProblem } from './mail-provider.ts'

test('a deployment that chose SES is not refused for missing a Resend key', () => {
  process.env.MAIL_PROVIDER = 'ses'
  process.env.SES_ACCESS_KEY_ID = 'AKIAEXAMPLE'
  process.env.SES_SECRET_ACCESS_KEY = 'secret'
  delete process.env.RESEND_API_KEY
  assert.equal(activeProvider(), 'ses')
  assert.equal(providerConfigProblem(), null)
})

test('each provider reports its own missing configuration', () => {
  process.env.MAIL_PROVIDER = 'ses'
  delete process.env.SES_ACCESS_KEY_ID
  delete process.env.SES_SECRET_ACCESS_KEY
  assert.match(providerConfigProblem() ?? '', /SES_ACCESS_KEY_ID/)

  process.env.MAIL_PROVIDER = 'resend'
  delete process.env.RESEND_API_KEY
  assert.match(providerConfigProblem() ?? '', /RESEND_API_KEY/)
})
