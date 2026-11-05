import assert from 'node:assert/strict'
import test from 'node:test'
import { sendIssues } from './checks.ts'
import { WRITING_DEFAULTS } from './settings.ts'

const base: { recipients: Array<{ email: string; name?: string }>; attachmentCount: number; ownDomains: string[] } = {
  recipients: [{ email: 'eric.samuel@coronation.ng', name: 'Eric Samuel' }],
  attachmentCount: 0,
  ownDomains: ['metroperilinsbrokers.com'],
}
const kinds = (body: string, extra: Partial<typeof base> = {}, settings = WRITING_DEFAULTS) =>
  sendIssues({ ...base, ...extra, body }, settings).map(issue => issue.kind)

test('a promised attachment with none attached is caught', () => {
  assert.deepEqual(kinds('Dear Eric,\nPlease find attached the schedule.'), ['attachment'])
  assert.deepEqual(kinds('Dear Eric,\nPlease find attached the schedule.', { attachmentCount: 1 }), [])
  assert.deepEqual(kinds('Dear Eric,\nThe documents are enclosed.'), ['attachment'])
  assert.deepEqual(kinds('Dear Eric,\nPlease find below the details.'), [])
})

test('empty body and leftover placeholders', () => {
  assert.deepEqual(kinds('   '), ['empty'])
  assert.deepEqual(kinds('Dear {first_name}, your renewal is due.'), ['placeholder'])
  assert.deepEqual(kinds('Dear Eric, premium is N[amount].'), ['placeholder'])
  assert.deepEqual(kinds('Dear Eric, see [cid:image001.png] below.'), [], 'an inline image marker is not a placeholder')
})

test('the greeting has to match a recipient', () => {
  assert.deepEqual(kinds('Dear Mr. Okafor,\nThanks.'), ['greeting'])
  assert.deepEqual(kinds('Dear Mr. Samuel,\nThanks.'), [])
  assert.deepEqual(kinds('Hi Eric,\nThanks.'), [])
  assert.deepEqual(kinds('Dear Sir,\nThanks.'), [])
  assert.deepEqual(kinds('Good morning all,\nThanks.'), [])
  assert.deepEqual(kinds('Hello, the schedule is below.'), [], 'an ordinary word after the greeting is not a name')
  assert.deepEqual(kinds('Hi there, thanks.'), [])
})

test('many outside recipients are flagged, colleagues are not counted', () => {
  const outsiders = Array.from({ length: 5 }, (_, index) => ({ email: `p${index}@insurer.com` }))
  assert.deepEqual(kinds('Hello all, thanks.', { recipients: outsiders }), ['external'])
  const colleagues = outsiders.map(entry => ({ email: entry.email.replace('insurer.com', 'metroperilinsbrokers.com') }))
  assert.deepEqual(kinds('Hello all, thanks.', { recipients: colleagues }), [])
})

test('every check can be switched off', () => {
  const off = { ...WRITING_DEFAULTS, checkAttachment: false, checkEmptyBody: false, checkPlaceholders: false, checkGreeting: false, checkExternal: false }
  assert.deepEqual(kinds('Dear {x} Okafor, attached', {}, off), [])
})

test('a reply that brings in a company the replied-to message did not have is flagged', () => {
  const recipients = [
    { email: 'chinedu@coronationinsurance.com.ng' },
    { email: 'muhammed.musa@prudentialzenith.com' },
    { email: 'eokpata.metroperil@gmail.com' },
    { email: 'info@metroperilinsbrokers.com' },
  ]
  const issues = sendIssues({ ...base, recipients, body: 'Dear Chinedu,\nNoted with thanks.', replyingToParties: ['coronationinsurance.com.ng'] }, WRITING_DEFAULTS)
  const flagged = issues.find(issue => issue.kind === 'other-company')
  assert.ok(flagged)
  assert.match(flagged.message, /prudentialzenith\.com/)
  assert.doesNotMatch(flagged.message, /gmail|metroperil/)
  const sameCompany = sendIssues({ ...base, recipients: recipients.slice(0, 1), body: 'Dear Chinedu,\nNoted.', replyingToParties: ['coronationinsurance.com.ng'] }, WRITING_DEFAULTS)
  assert.equal(sameCompany.some(issue => issue.kind === 'other-company'), false)
  const coInsurance = sendIssues({ ...base, recipients, body: 'Dear Chinedu,\nNoted.', replyingToParties: ['coronationinsurance.com.ng', 'prudentialzenith.com'] }, WRITING_DEFAULTS)
  assert.equal(coInsurance.some(issue => issue.kind === 'other-company'), false, 'both companies were already on the message')
  const fresh = sendIssues({ ...base, recipients, body: 'Dear Chinedu,\nNoted.' }, WRITING_DEFAULTS)
  assert.equal(fresh.some(issue => issue.kind === 'other-company'), false, 'a new message is not a reply')
})
