import assert from 'node:assert/strict'
import test from 'node:test'
import { checkableWord, correctWord, formatAmount, startsSentence, wordsOf } from './text.ts'

test('a sentence starts after a full stop, question or exclamation, and at a paragraph start', () => {
  assert.equal(startsSentence(''), true)
  assert.equal(startsSentence('   '), true)
  assert.equal(startsSentence('Thank you. '), true)
  assert.equal(startsSentence('Is it ready? '), true)
  assert.equal(startsSentence('Done! '), true)
  assert.equal(startsSentence('He said "yes." '), true)
  assert.equal(startsSentence('Thank you.'), false, 'no space yet')
  assert.equal(startsSentence('Thank you '), false)
})

test('abbreviations, initials and ellipses do not start a sentence', () => {
  assert.equal(startsSentence('for e.g. '), false)
  assert.equal(startsSentence('i.e. '), false)
  assert.equal(startsSentence('Metroperil Ltd. '), false)
  assert.equal(startsSentence('Policy No. '), false)
  assert.equal(startsSentence('Dear Mr. '), false)
  assert.equal(startsSentence('from J. '), false)
  assert.equal(startsSentence('Well... '), false)
  assert.equal(startsSentence('see info@x.com. '), false)
  assert.equal(startsSentence('visit www. '), false, 'www. is an address, not a sentence end')
})

test('typos are corrected keeping their capitals', () => {
  assert.equal(correctWord('teh'), 'the')
  assert.equal(correctWord('Teh'), 'The')
  assert.equal(correctWord('TEH'), 'THE')
  assert.equal(correctWord('dont'), "don't")
  assert.equal(correctWord('recieved'), 'received')
  assert.equal(correctWord('the'), null)
})

test('amounts in any currency are grouped', () => {
  const on = { nairaLetter: true, plainNumbers: false }
  assert.equal(formatAmount('N1500000', on), '\u20a61,500,000')
  assert.equal(formatAmount('NGN2500.50', on), 'NGN2,500.50')
  assert.equal(formatAmount('$2500', on), '$2,500')
  assert.equal(formatAmount('\u00a31250000', on), '\u00a31,250,000')
  assert.equal(formatAmount('USD150000', on), 'USD150,000')
  assert.equal(formatAmount('2500', on, 'USD'), '2,500', 'a code written apart still makes it money')
  assert.equal(formatAmount('N1500000', { ...on, nairaLetter: false }), null)
  assert.equal(formatAmount('N123', on), null, 'too short to be an amount')
  assert.equal(formatAmount('NIGERIA', on), null)
})

test('plain numbers are grouped only when asked, and never years, phones or account numbers', () => {
  const plain = { nairaLetter: true, plainNumbers: true }
  assert.equal(formatAmount('1500000', plain), '1,500,000')
  assert.equal(formatAmount('15000.75', plain), '15,000.75')
  assert.equal(formatAmount('1500000', { ...plain, plainNumbers: false }), null)
  assert.equal(formatAmount('2026', plain), null, 'a year')
  assert.equal(formatAmount('08061397800', plain), null, 'a phone number')
  assert.equal(formatAmount('2034567890', plain), null, 'a ten-digit account number')
})

test('only real words are checked', () => {
  const options = { ignoreCapitals: true, ignoreWithNumbers: true }
  assert.equal(checkableWord('insurance', options), true)
  assert.equal(checkableWord('LASACO', options), false)
  assert.equal(checkableWord('LASACO', { ...options, ignoreCapitals: false }), true)
  assert.equal(checkableWord('AKD792', options), false)
  assert.equal(checkableWord('a', options), false)
})

test('addresses are not split into words', () => {
  assert.deepEqual(wordsOf('Mail info@metroperil.com today').map(entry => entry.word), ['Mail', 'today'])
  assert.deepEqual(wordsOf("don't stop").map(entry => entry.word), ["don't", 'stop'])
})

test('templates fill what they can and leave the rest to Tab through', async () => {
  const { fillTemplate, normaliseShortcut } = await import('./templates.ts')
  const html = fillTemplate('<p>Dear {first_name}, as at {date} policy {policy_no} is due. {sender_name}</p>', { firstName: 'Eric', senderName: 'Richard' }, new Date('2026-09-23T10:00:00Z'))
  assert.equal(html, '<p>Dear Eric, as at 23 September 2026 policy {policy_no} is due. Richard</p>')
  assert.equal(normaliseShortcut(';Renewal Notice'), 'renewalnotice')
})

test('a first name is read from a personal address, never from a shared one', async () => {
  const { firstNameFromAddress } = await import('./templates.ts')
  assert.equal(firstNameFromAddress('eric.samuel@coronation.ng'), 'Eric')
  assert.equal(firstNameFromAddress('sijuatobatele@lasaco.com'), 'Sijuatobatele')
  assert.equal(firstNameFromAddress('info@metroperil.com'), undefined)
  assert.equal(firstNameFromAddress('claims@insurer.com'), undefined)
  assert.equal(firstNameFromAddress('a2b@x.com'), undefined)
})
