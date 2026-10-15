import assert from 'node:assert/strict'
import { inlineImageUrls, resolveInlineImages } from './attachments.ts'
import { inlineImageTicket, inlineImageTicketValid } from './share-ticket.ts'

process.env.MAIL_SESSION_SECRET = 'test-secret'

const ticket = inlineImageTicket('msg~a.b@example.com')!
assert.ok(inlineImageTicketValid(ticket, 'msg~a.b@example.com'))
assert.equal(inlineImageTicketValid(ticket, 'other'), false, 'a ticket opens only its own message')
assert.equal(inlineImageTicketValid(`${ticket}x`, 'msg~a.b@example.com'), false)
assert.equal(inlineImageTicketValid(null, 'msg~a.b@example.com'), false)
assert.equal(inlineImageTicket('msg', 1_000), inlineImageTicket('msg', 2_000), 'stable within a window, so the frame does not reload')
assert.equal(inlineImageTicketValid(inlineImageTicket('msg', 0), 'msg'), false, 'old tickets expire')

const urls = inlineImageUrls('m1', [
  { filename: 'report.pdf', key: 'k0' },
  { filename: 'image.png', key: 'k1', contentId: '<431E9FB0-27a3>' },
  { filename: 'image.png', contentId: 'nokey' },
], 'T')
assert.deepEqual(Object.keys(urls), ['431e9fb0-27a3'])
assert.equal(urls['431e9fb0-27a3'], '/api/mail/inbox/attachments/download?id=m1&index=1&inline=1&t=T')

const html = '<img src="cid:431e9fb0-27a3"><img src=\'cid:<431E9FB0-27A3>\'><img src="cid:unknown"><td background="cid:431e9fb0-27a3">'
assert.equal(
  resolveInlineImages(html, urls, 'https://mail.test'),
  '<img src="https://mail.test/api/mail/inbox/attachments/download?id=m1&index=1&inline=1&t=T"><img src=\'https://mail.test/api/mail/inbox/attachments/download?id=m1&index=1&inline=1&t=T\'><img src="cid:unknown"><td background="https://mail.test/api/mail/inbox/attachments/download?id=m1&index=1&inline=1&t=T">',
)
assert.equal(resolveInlineImages(html, undefined), html)
console.log('inline images ok')
