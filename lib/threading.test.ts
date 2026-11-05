import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const directory = mkdtempSync(join(tmpdir(), 'threading-test-'))
process.env.DATABASE_URL = `file:${directory}/test.sqlite`
process.env.MAIL_ADDRESS_DOMAIN = 'metro.example'
process.env.MAIL_SEATS = '[]'
process.env.THREADS_LIVE = '1'
after(() => rmSync(directory, { recursive: true, force: true }))

const owner = 'eokpata@metro.example'

async function receive(id: string, from: string, subject: string, at: string, headers: Record<string, string>) {
  const mailbox = await import('./mailbox.ts')
  await mailbox.appendInbound({ id, from, to: [owner], cc: [], bcc: [], replyTo: [], subject, html: null, text: 'body', headers, receivedAt: at, read: false, attachments: [], owner })
}

async function threadOf(id: string): Promise<string> {
  const { db } = await import('./mailbox.ts')
  const rows = await db()`SELECT thread_id FROM mail_inbox WHERE id = ${id}`
  return String(rows[0]?.thread_id)
}

test('conversations follow reply headers and the subject, as Gmail does', async () => {
  const mailbox = await import('./mailbox.ts')
  await receive('cor-1', 'uw@coronation.example', 'CREDIT LIFE QUOTE', '2026-10-16T10:20:00.000Z', { 'message-id': '<cor-1@coronation.example>' })
  await receive('pz-1', 'musa@zenith.example', 'CREDIT LIFE QUOTE', '2026-10-16T10:30:00.000Z', { 'message-id': '<pz-1@zenith.example>' })
  assert.notEqual(await threadOf('cor-1'), await threadOf('pz-1'), 'the same title from two companies is two conversations')

  await mailbox.recordSentMessage({ id: 'vela-sent-1', from: owner, to: ['uw@coronation.example'], cc: [], bcc: [], replyTo: [], subject: 'Re: CREDIT LIFE QUOTE', html: null, text: 'ok', createdAt: '2026-10-16T13:43:00.000Z', providerId: '011001a1-ses-id-000000' })
  await mailbox.recordSentMeta('vela-sent-1', owner, false, '<cor-1@coronation.example>')
  await receive('cor-2', 'uw@coronation.example', 'Re: CREDIT LIFE QUOTE', '2026-10-17T09:00:00.000Z', {
    'message-id': '<cor-2@coronation.example>',
    'in-reply-to': '<011001a1-ses-id-000000@eu-north-1.amazonses.com>',
  })
  assert.equal(await threadOf('cor-2'), await threadOf('cor-1'), "a reply that names only our sent message joins the message we answered")

  await receive('pz-2', 'musa@zenith.example', 'RE: Credit Life Quote', '2026-10-17T10:00:00.000Z', {
    'message-id': '<pz-2@zenith.example>',
    'in-reply-to': '<pz-1@zenith.example>',
    references: '<pz-1@zenith.example>',
  })
  assert.equal(await threadOf('pz-2'), await threadOf('pz-1'))
  assert.notEqual(await threadOf('pz-2'), await threadOf('cor-1'))

  await receive('cor-3', 'uw@coronation.example', 'Policy schedule attached', '2026-10-18T09:00:00.000Z', {
    'message-id': '<cor-3@coronation.example>',
    'in-reply-to': '<cor-2@coronation.example>',
  })
  assert.notEqual(await threadOf('cor-3'), await threadOf('cor-1'), 'a changed subject starts a new conversation')

  await receive('cor-4', 'uw@coronation.example', 'Re: CREDIT LIFE QUOTE', '2026-10-19T09:00:00.000Z', { 'message-id': '<cor-4@coronation.example>' })
  assert.notEqual(await threadOf('cor-4'), await threadOf('cor-1'), 'the same subject with no reply headers is not joined')
  assert.notEqual(await threadOf('cor-4'), await threadOf('pz-1'))
})
