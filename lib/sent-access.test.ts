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
process.env.RESEND_FROM = 'Example <hello@example.com>'
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
