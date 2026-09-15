import assert from 'node:assert/strict'
import { inlineEmailStyles, htmlToPlainText, safeHref, dropUnreachableImages, outlookSafeImages } from './email-html.ts'

// A paragraph with no styling of its own gets the base inline style.
assert.match(inlineEmailStyles('<p>Hello</p>'), /<p style="font-family:Arial[^"]*">Hello<\/p>/)

// The author's own colour survives, and sits after the base so it wins.
const coloured = inlineEmailStyles('<p style="color:#ff0000">Red</p>')
assert.ok(coloured.includes('color:#ff0000'), 'author colour kept')
assert.ok(coloured.indexOf('font-family') < coloured.indexOf('color:#ff0000'), 'author style wins')

// Tags we do not style are left exactly as they were.
assert.equal(inlineEmailStyles('<strong>bold</strong>'), '<strong>bold</strong>')

// Lists, links and tables all pick up styles.
assert.match(inlineEmailStyles('<a href="https://x.test">x</a>'), /style="color:/)
assert.match(inlineEmailStyles('<td>c</td>'), /border:1px solid/)

// Plain text falls out readable, with list bullets preserved.
assert.equal(htmlToPlainText('<p>One</p><ul><li>A</li><li>B</li></ul>'), 'One\n\n  • A\n  • B')
assert.equal(htmlToPlainText('<p>a &amp; b</p>'), 'a & b')

// A bare domain becomes https, an address becomes mailto.
assert.equal(safeHref('example.com'), 'https://example.com')
assert.equal(safeHref('  claims@example.com '), 'mailto:claims@example.com')

// Addresses that already carry an allowed scheme are left alone.
assert.equal(safeHref('https://x.test/a'), 'https://x.test/a')
assert.equal(safeHref('tel:+2348000000000'), 'tel:+2348000000000')

// Script-bearing schemes are refused outright, in any casing or padding.
assert.equal(safeHref('javascript:alert(1)'), null)
assert.equal(safeHref('  JavaScript:alert(1)'), null)
assert.equal(safeHref('data:text/html;base64,PHN2Zz4='), null)
assert.equal(safeHref('file:///etc/passwd'), null)
assert.equal(safeHref('   '), null)

// A path-bearing value with an @ in it is a URL, not an email address.
assert.equal(safeHref('x.test/u@v'), 'https://x.test/u@v')

console.log('email-html: all assertions passed')

// A signature pasted from Outlook carries a file:// image nobody else can load.
assert.equal(
  dropUnreachableImages('<p></p><img src="file:///C:/Users/x/logo.png"><p>Name</p><img src="https://a.b/l.png" alt="">'),
  '<p></p><p>Name</p><img src="https://a.b/l.png" alt="">',
)
assert.equal(dropUnreachableImages('<img src="cid:abc">x<img src="/api/mail/signature-logo?key=signatures/a.png">'), 'x<img src="/api/mail/signature-logo?key=signatures/a.png">')

// A profile's default font reaches every paragraph, but headings keep their own size.
const based = inlineEmailStyles('<p>Hi</p><h1>Title</h1>', { family: 'Poppins', size: '17px' })
assert.match(based, /<p style="font-family:'Poppins',Arial,Helvetica,sans-serif;font-size:17px;/)
assert.match(based, /<h1 style="font-family:'Poppins',Arial,Helvetica,sans-serif;font-size:24px;/)

// A plain left-aligned image is not worth a table, so it is left exactly as it was.
const plainImage = '<img src="https://x.test/m.png" style="display:block;width:200px;height:auto;border:0;">'
assert.equal(outlookSafeImages(plainImage), plainImage)

// A framed one becomes a one-cell table, because Word ignores borders on an image.
const framed = outlookSafeImages('<img src="https://x.test/m.png" style="display:block;width:140px;border:1px solid #a90317;padding:8px;border-radius:8px;">')
assert.match(framed, /<table[^>]+align="left"/, 'framed image is wrapped in a table')
assert.match(framed, /<td style="[^"]*border:1px solid #a90317/, 'the border moves to the cell')
assert.match(framed, /<td style="[^"]*padding:8px/, 'so does the padding')
assert.match(framed, /<img[^>]+style="display:block;width:140px;height:auto;border:0"/, 'the image itself is left plain')

// Centring needs the table too, and the alignment marker never reaches the recipient.
const centred = outlookSafeImages('<img src="https://x.test/m.png" data-align="center" style="display:block;width:90px;border:0;">')
assert.match(centred, /<table[^>]+align="center"/, 'centred image is wrapped')
assert.ok(!centred.includes('data-align'), 'the editor marker is stripped')

// A linked logo keeps its link, inside the cell rather than around the table.
const linked = outlookSafeImages('<a href="https://x.test"><img src="https://x.test/m.png" style="display:block;width:100px;border:1px solid #000;"></a>')
assert.match(linked, /<td[^>]*><a href="https:\/\/x\.test"><img/, 'the anchor sits inside the cell')
