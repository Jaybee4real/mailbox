import assert from 'node:assert/strict'

process.env.MAIL_ADDRESS_DOMAIN = 'example.com'
const { judgeMessage, FIRST_MESSAGE_REASON } = await import('./risk.ts')
type Standing = Parameters<typeof judgeMessage>[1]

const stranger: Standing = { received: 0, trashed: 0, markedSpam: 0, replied: 0, trusted: false, firstSeen: null }
const known = (firstSeen: string, extra: Partial<Standing> = {}): Standing => ({ ...stranger, received: 2, firstSeen, ...extra })

const promo = { from: 'Swift <customercare@swiftng.net>', spf: 'fail', subject: 'We Want You Back', receivedAt: '2026-09-23T20:36:05.281Z' }
assert.equal(judgeMessage(promo, known('2022-01-10T10:49:25.000Z')).risk, 'clean', 'a sender with years of history is not writing for the first time')
const firstTime = judgeMessage(promo, stranger)
assert.equal(firstTime.risk, 'suspicious')
assert.ok(firstTime.reasons.includes(FIRST_MESSAGE_REASON), 'a real first message still says so')
assert.ok(!judgeMessage(promo, known('2026-09-23T20:30:00.000Z')).reasons.includes(FIRST_MESSAGE_REASON), 'the second message is not the first')
assert.ok(judgeMessage(promo, known(promo.receivedAt)).reasons.includes(FIRST_MESSAGE_REASON), 'the earliest stored message is the first, when re-judged')

const enquiry = {
  from: 'Example Website <no-reply@example.com>',
  replyTo: ['someone@gmail.com'],
  dmarc: 'pass',
  spf: 'pass',
  dkim: 'pass',
  subject: 'New enquiry — Motor insurance',
  receivedAt: '2026-09-14T07:24:40.046Z',
}
assert.equal(judgeMessage(enquiry, stranger).risk, 'clean', 'our own authenticated form mail is not a stranger misdirecting replies')
const forged = judgeMessage({ ...enquiry, dmarc: 'fail', spf: 'fail', dkim: 'fail' }, stranger)
assert.notEqual(forged.risk, 'clean', 'mail that only claims our domain earns nothing')
assert.equal(judgeMessage({ ...enquiry, from: 'Web <no-reply@example.org>' }, stranger).risk, 'suspicious', 'another domain doing the same is still flagged')

assert.equal(judgeMessage(promo, { ...stranger, trusted: true }).risk, 'clean', 'a trusted sender is forgiven the small stuff')
assert.notEqual(judgeMessage(promo, { ...stranger, trusted: true, markedSpam: 2 }).risk, 'clean', 'marking spam outranks trust')

console.log('risk: ok')
