import assert from 'node:assert/strict'
import { inlineImageUrls, outgoingInlineParts, resolveInlineImages } from './attachments.ts'
import { inlineImageTicket, inlineImageTicketValid } from './share-ticket.ts'

process.env.MAIL_SESSION_SECRET = 'test-secret'

const ticket = inlineImageTicket('msg~a.b@example.com')!
assert.ok(inlineImageTicketValid(ticket, 'msg~a.b@example.com'))
assert.equal(inlineImageTicketValid(ticket, 'other'), false, 'a ticket opens only its own message')
assert.equal(inlineImageTicketValid(`${ticket}x`, 'msg~a.b@example.com'), false)
assert.equal(inlineImageTicketValid(null, 'msg~a.b@example.com'), false)
assert.equal(inlineImageTicket('msg', 1_000), inlineImageTicket('msg', 2_000), 'stable within a window, so the frame does not reload')
assert.equal(inlineImageTicketValid(inlineImageTicket('msg', 0), 'msg'), false, 'old tickets expire')

assert.equal(inlineImageTicketValid(ticket, 'msg~a.b@example.com', Date.now(), 'sent'), false, 'an inbound ticket does not open sent mail')
assert.ok(inlineImageTicketValid(inlineImageTicket('s1', Date.now(), 'sent'), 's1', Date.now(), 'sent'))

const urls = inlineImageUrls([
  { filename: 'report.pdf', key: 'k0' },
  { filename: 'image.png', key: 'k1', contentId: '<431E9FB0-27a3>' },
  { filename: 'image.png', contentId: 'nokey' },
], index => `/api/mail/inbox/attachments/download?id=m1&index=${index}&inline=1&t=T`)
assert.deepEqual(Object.keys(urls), ['431e9fb0-27a3'])
assert.equal(urls['431e9fb0-27a3'], '/api/mail/inbox/attachments/download?id=m1&index=1&inline=1&t=T')

const html = '<img src="cid:431e9fb0-27a3"><img src=\'cid:<431E9FB0-27A3>\'><img src="cid:unknown"><td background="cid:431e9fb0-27a3">'
assert.equal(
  resolveInlineImages(html, urls, 'https://mail.test'),
  '<img src="https://mail.test/api/mail/inbox/attachments/download?id=m1&index=1&inline=1&t=T"><img src=\'https://mail.test/api/mail/inbox/attachments/download?id=m1&index=1&inline=1&t=T\'><img src="cid:unknown"><td background="https://mail.test/api/mail/inbox/attachments/download?id=m1&index=1&inline=1&t=T">',
)
assert.equal(resolveInlineImages(html, undefined), html)
const long = `${'x'.repeat(80)}@outlook`
const outgoing = outgoingInlineParts(
  [
    { filename: 'logo.png', contentId: '<Logo@X>' },
    { filename: 'gone.png', contentId: 'removed@x' },
    { filename: 'big.png', contentId: long },
    { filename: 'report.pdf' },
  ],
  `<img src="cid:logo@x"><img src='cid:${long}'>`,
)
assert.deepEqual(outgoing.files, [
  { filename: 'logo.png', contentId: 'Logo@X' },
  { filename: 'big.png', contentId: 'part2@inline' },
  { filename: 'report.pdf' },
], 'a part the body no longer draws is dropped, and an over-long id is renamed')
assert.equal(outgoing.html, `<img src="cid:Logo@X"><img src='cid:part2@inline'>`)
assert.deepEqual(outgoingInlineParts([{ filename: 'a.pdf' }], null), { files: [{ filename: 'a.pdf' }], html: null })
console.log('inline images ok')
