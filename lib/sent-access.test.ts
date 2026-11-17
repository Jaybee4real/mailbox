import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = specifier.startsWith('@/') ? new URL(specifier.slice(2), root).href : specifier
    const local = target.startsWith('.') || target.startsWith('file:')
    if (local && !/\.[cm]?[jt]sx?$/.test(target)) {
      const absolute = new URL(target, context.parentURL)
      if (existsSync(`${fileURLToPath(absolute)}.ts`)) return nextResolve(`${absolute.href}.ts`, context)
    }
    return nextResolve(target, context)
  },
})

process.env.DATABASE_URL = 'file::memory:'
process.env.MAIL_SEATS = '[]'
process.env.MAIL_SUPPORT_EMAIL = 'hello@example.com'
process.env.MAIL_ALL_INBOXES_ADDRESS = 'boss@example.com'

const mailbox = await import('./mailbox.ts')
const access = await import('./sent-access.ts')

const member = { address: 'ada@example.com', role: 'member' as const }
const shared = { address: 'hello@example.com', role: 'admin' as const }

const sent = (id: string, from: string) =>
  mailbox.recordSentMessage({ id, from, to: ['client@elsewhere.com'], cc: [], bcc: [], replyTo: [], subject: id, html: null, text: null, createdAt: new Date().toISOString(), lastEvent: null })

test('sent mail belongs to its assignment, else its sender, else the shared address', async () => {
  await mailbox.createAccount({ email: 'ada@example.com', address: 'ada@example.com', status: 'active' })
  await sent('from-ada', 'Ada <Ada@example.com>')
  await sent('from-shared', 'Example <hello@example.com>')
  await sent('from-stranger', 'someone@example.com')
  await sent('assigned', 'Example <hello@example.com>')
  await mailbox.setSentMetaOwner('assigned', 'Ada@Example.com')

  assert.deepEqual(await access.sentOwners(['from-ada', 'from-shared', 'from-stranger', 'assigned', 'never-stored', 'from-ada']), {
    'from-ada': 'ada@example.com',
    'from-shared': 'hello@example.com',
    'from-stranger': 'hello@example.com',
    assigned: 'ada@example.com',
    'never-stored': 'hello@example.com',
  })
  assert.deepEqual(await access.sentOwners([]), {})

  assert.equal(await access.mayReadSent(member, 'from-ada'), true)
  assert.equal(await access.mayReadSent(member, 'assigned'), true)
  assert.equal(await access.mayReadSent(member, 'from-shared'), false)
  assert.equal(await access.mayReadSent(shared, 'from-shared'), true)
  assert.equal(await access.mayReadSent(shared, 'from-ada'), false)
  assert.equal(await access.mayReadSent({ address: null }, 'from-ada'), false)

  const everything = ['from-ada', 'assigned', 'from-shared']
  assert.deepEqual(await access.changeableSentIds(member, everything), ['from-ada', 'assigned'], "a colleague cannot trash someone else's Sent copy")
  assert.deepEqual(await access.changeableSentIds({ address: 'boss@example.com', role: 'admin' }, everything), everything)
  assert.deepEqual(await access.changeableSentIds({ address: null, role: 'member' }, everything), [])
})

test('removing an account kills its outstanding reset and invite links', async () => {
  await mailbox.createAccount({ email: 'leaver@example.com', address: 'leaver@example.com', status: 'pending' })
  await mailbox.createResetToken('leaver@example.com', 'invite-token', Date.now() + 3_600_000)
  await mailbox.createResetToken('ada@example.com', 'ada-token', Date.now() + 3_600_000)
  await mailbox.deleteAccount('Leaver@Example.com')
  assert.equal(await mailbox.resetTokenEmail('invite-token'), null)
  assert.equal(await mailbox.resetPasswordWithToken('invite-token', 'hash'), null)
  assert.equal(await mailbox.getAccount('leaver@example.com'), null, 'the link cannot recreate the account')
  assert.equal(await mailbox.resetTokenEmail('ada-token'), 'ada@example.com', 'other accounts keep theirs')
})

test('reset links are stored only as a digest and work once', async () => {
  await mailbox.createAccount({ email: 'hashed@example.com', address: 'hashed@example.com', status: 'active' })
  await mailbox.createResetToken('hashed@example.com', 'plain-reset-token', Date.now() + 3_600_000)
  const stored = await mailbox.db()`SELECT token FROM mail_reset_tokens WHERE email = 'hashed@example.com'`
  assert.equal(stored.length, 1)
  assert.notEqual(stored[0].token, 'plain-reset-token')
  assert.equal(await mailbox.resetTokenEmail(String(stored[0].token)), null, 'the stored value is not itself a working link')
  assert.equal(await mailbox.resetPasswordWithToken('plain-reset-token', 'hash'), 'hashed@example.com')
  assert.equal(await mailbox.resetPasswordWithToken('plain-reset-token', 'hash'), null)
})

test('received mail is readable by its owner, the shared address for unowned rows, and the all-inboxes reader', async () => {
  const received = (id: string, owner: string | null) =>
    mailbox.appendInbound({ id, from: 'client@elsewhere.com', to: ['x@example.com'], cc: [], bcc: [], replyTo: [], subject: id, html: null, text: null, headers: {}, receivedAt: new Date().toISOString(), read: false, attachments: [], owner })
  await received('to-ada', 'ada@example.com')
  await received('to-shared', 'hello@example.com')
  await received('unowned', null)

  assert.equal(await access.mayReadInbound(member, 'to-ada'), true)
  assert.equal(await access.mayReadInbound({ ...member, address: ' ADA@example.com ' }, 'to-ada'), true)
  assert.equal(await access.mayReadInbound(member, 'to-shared'), false)
  assert.equal(await access.mayReadInbound(member, 'unowned'), false)
  assert.equal(await access.mayReadInbound(shared, 'to-shared'), true)
  assert.equal(await access.mayReadInbound(shared, 'unowned'), true)
  assert.equal(await access.mayReadInbound(shared, 'to-ada'), false, 'administering accounts is not reading them')
  assert.equal(await access.mayReadInbound(member, 'missing'), false)
  assert.equal(await access.mayReadInbound({ address: null, role: 'member' }, 'to-ada'), false)

  const everyone = { address: 'boss@example.com', role: 'admin' as const }
  assert.equal(await access.mayReadInbound(everyone, 'to-ada'), true)
  assert.equal(await access.mayReadInbound(everyone, 'to-shared'), true)
  assert.equal(await access.mayReadInbound({ ...everyone, role: 'member' }, 'to-ada'), false, 'the all-inboxes address must also be an admin')
})
