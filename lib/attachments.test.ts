import assert from 'node:assert/strict'
import { attachmentHeaders } from './attachments.ts'

const served = (filename: string, inline: boolean) => {
  const headers = attachmentHeaders(filename, inline)
  return [headers['content-type'], headers['content-disposition'].split(';')[0]]
}

assert.deepEqual(served('Statement.PDF', true), ['application/pdf', 'inline'])
assert.deepEqual(served('photo.jpeg', true), ['image/jpeg', 'inline'])
assert.deepEqual(served('photo.jpg', false), ['image/jpeg', 'attachment'], 'the download button still saves')
assert.deepEqual(served('clip.mov', true), ['video/quicktime', 'inline'])
assert.deepEqual(served('memo.m4a', true), ['audio/mp4', 'inline'])
assert.deepEqual(served('notes.txt', true), ['text/plain; charset=utf-8', 'inline'])

assert.deepEqual(served('invoice.html', true), ['application/octet-stream', 'attachment'], 'html never renders')
assert.deepEqual(served('logo.svg', true), ['application/octet-stream', 'attachment'], 'svg never renders')
assert.deepEqual(served('report.xhtml', true), ['application/octet-stream', 'attachment'])
assert.deepEqual(served('trick.pdf.html', true), ['application/octet-stream', 'attachment'], 'only the last extension counts')
assert.deepEqual(served('pdf', true), ['application/octet-stream', 'attachment'], 'a bare name has no extension')
assert.deepEqual(served('budget.xlsx', true), ['application/octet-stream', 'attachment'])

const quoted = attachmentHeaders('a"b\\c.pdf', true)
assert.equal(quoted['content-disposition'], 'inline; filename="abc.pdf"', 'quotes cannot break out of the filename')
assert.equal(quoted['x-content-type-options'], 'nosniff')

console.log('attachments: ok')

const curly = attachmentHeaders('Driver\u2019s License \u2013 SHERIFF .pdf', true)
assert.doesNotThrow(() => new Headers(curly), 'a curly apostrophe or dash cannot make the response fail')
assert.equal(curly['content-disposition'], "inline; filename=\"Driver's License - SHERIFF .pdf\"; filename*=UTF-8''Driver%E2%80%99s%20License%20%E2%80%93%20SHERIFF%20.pdf")
assert.doesNotThrow(() => new Headers(attachmentHeaders('\u0639\u0642\u062f \ud83d\ude97.pdf', false)), 'any script or emoji is safe')
assert.equal(attachmentHeaders('plain.pdf', false)['content-disposition'], 'attachment; filename="plain.pdf"', 'a plain name stays plain')
console.log('attachments: header filenames are always valid')
