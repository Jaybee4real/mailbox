import assert from 'node:assert/strict'
import test from 'node:test'

process.env.DATABASE_URL = 'file::memory:'
process.env.MAIL_SEATS = '[]'

test('an admin without two-step sign-in is refused admin actions until one method is on', async () => {
  const mailbox = await import('./mailbox')
  const auth = await import('./dev-auth')
  await mailbox.createAccount({ email: 'chief@example.com', address: 'chief@example.com', status: 'active', role: 'admin' })
  const chief = { email: 'chief@example.com', role: 'admin' as const }
  const member = { email: 'ada@example.com', role: 'member' as const }
  assert.equal(await auth.adminNeedsTwoStep(chief), true)
  assert.equal((await auth.adminRefusal(chief))?.status, 403)
  assert.equal((await auth.adminRefusal(member))?.status, 403)
  assert.equal(await auth.adminNeedsTwoStep(member), false, 'members are not required to')

  await mailbox.setRecoveryEmail('chief@example.com', 'chief@elsewhere.com')
  await mailbox.markRecoveryVerified('chief@example.com', 'chief@elsewhere.com')
  await mailbox.setEmailCodes('chief@example.com', true)
  assert.equal(await auth.adminRefusal(chief), null, 'email codes to the recovery address count')

  await mailbox.setRecoveryEmail('chief@example.com', 'new@elsewhere.com')
  assert.equal(await auth.adminNeedsTwoStep(chief), true, 'an unconfirmed recovery address is not a second step')

  await mailbox.setTotpPending('chief@example.com', 'JBSWY3DPEHPK3PXP')
  await mailbox.activateTotp('chief@example.com')
  assert.equal(await auth.adminRefusal(chief), null, 'an authenticator app counts')
})
