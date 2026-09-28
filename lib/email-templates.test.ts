import assert from 'node:assert/strict'
import test from 'node:test'

test('a follow-up template is offered only where the deployment lists it', async () => {
  const { templateEnabled } = await import('./emails/index.ts')

  assert.equal(templateEnabled('academy', ''), false, 'off unless listed')
  assert.equal(templateEnabled('contact', ''), false)
  assert.equal(templateEnabled('academy', 'academy, contact'), true)
  assert.equal(templateEnabled('contact', 'academy,contact'), true)
  assert.equal(templateEnabled('Contact', 'contact'), true)
  assert.equal(templateEnabled('contact', 'academy'), false, 'one listed does not enable the other')
  assert.equal(templateEnabled(undefined, 'academy,contact'), false)
})
