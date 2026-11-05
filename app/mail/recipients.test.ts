import assert from 'node:assert/strict'
import test from 'node:test'
import { replyAllFor, replyFor } from './recipients.ts'

const self = new Set(['eokpata@metroperilinsbrokers.com', 'info@metroperilinsbrokers.com'])

test('reply all goes only to the people on the message being answered', () => {
  const coronationAnswer = {
    from: 'Chinedu Ogoamaka <Chinedu.Ogoamaka@coronationinsurance.com.ng>',
    to: ['eokpata@metroperilinsbrokers.com'],
    cc: ['kenneth.essu@coronationinsurance.com.ng', 'info@metroperilinsbrokers.com', 'rokoeman@metroperilinsbrokers.com'],
    replyTo: [],
  }
  assert.deepEqual(replyAllFor(coronationAnswer, self), {
    to: ['Chinedu.Ogoamaka@coronationinsurance.com.ng'],
    cc: ['kenneth.essu@coronationinsurance.com.ng', 'rokoeman@metroperilinsbrokers.com'],
  })
})

test('reply-to replaces the sender, duplicates and our own seats are dropped', () => {
  const message = {
    from: 'Bot <noreply@zenith.example>',
    to: ['eokpata@metroperilinsbrokers.com', 'UW@zenith.example', 'uw@zenith.example'],
    cc: ['uw@zenith.example', 'Info@metroperilinsbrokers.com'],
    replyTo: ['Desk <desk@zenith.example>'],
  }
  assert.deepEqual(replyAllFor(message, self), { to: ['desk@zenith.example', 'UW@zenith.example'], cc: [] })
})

test('replying to a message we sent ourselves goes to the people it was sent to, as in Gmail and Outlook', () => {
  const ownMessage = {
    from: 'E. Okpata <eokpata@metroperilinsbrokers.com>',
    to: ['chinedu@coronationinsurance.com.ng', 'kenneth@coronationinsurance.com.ng'],
    cc: ['uw@coronationinsurance.com.ng'],
    replyTo: [],
  }
  assert.deepEqual(replyFor(ownMessage, self), ['chinedu@coronationinsurance.com.ng', 'kenneth@coronationinsurance.com.ng'])
  assert.deepEqual(replyAllFor(ownMessage, self), {
    to: ['chinedu@coronationinsurance.com.ng', 'kenneth@coronationinsurance.com.ng'],
    cc: ['uw@coronationinsurance.com.ng'],
  })
  assert.deepEqual(replyFor({ from: 'Ada <ada@client.example>', to: ['eokpata@metroperilinsbrokers.com'], cc: [], replyTo: [] }, self), ['ada@client.example'])
})
