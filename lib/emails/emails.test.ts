import assert from 'node:assert/strict'

process.env.BRAND_NAME = 'Example'
process.env.MAIL_ADDRESS_DOMAIN = 'example.com'
process.env.BRAND_COLOR_ACCENT = 'rgb(5, 96, 250)'
const emails = await import('./index.ts')

const hostile = '<script>alert(1)</script>'
const rendered: Array<[string, string]> = [
  ['reset', emails.renderActionEmail({ eyebrow: 'Example · Mail', title: 'Reset your password', body: `Someone asked to reset the password for ${hostile}.`, actionLabel: 'Set a new password', actionUrl: 'https://mail.example.com/mail/reset?token=abc', expiry: 'This link expires in 30 minutes.', footer: 'Ignore this if it was not you.' })],
  ['sign-in code', emails.renderActionEmail({ eyebrow: 'Example · Mail', code: '123456', recipient: 'ada@example.org', reason: 'because two-step sign-in by email is on for your account', title: '123456', body: 'Enter this code.', actionLabel: 'Open', actionUrl: 'https://mail.example.com/mail', expiry: 'Expires in 10 minutes.', footer: 'Not you? Change your password.' })],
  ['academy follow-up', emails.renderAcademyFollowupEmail({ firstName: hostile, courses: 'Programming', cohortDate: 'March 2027' })],
  ['contact follow-up', emails.renderContactFollowupEmail({ firstName: 'Ada', projectType: 'Mobile app', includeAcademy: 'true' })],
  ['notification', emails.renderNotificationEmail('project', [{ label: 'Name', value: hostile }])],
]

for (const [name, html] of rendered) {
  assert.ok(!/localhost|127\.0\.0\.1/.test(html), `${name}: no local addresses`)
  assert.ok(!html.includes('<script>'), `${name}: user input is escaped`)
  assert.match(html, /prefers-color-scheme: dark/, `${name}: carries the dark version`)
  assert.match(html, /Example Mail|Example/, `${name}: carries the deployment's brand`)
}
assert.match(rendered[0][1], /href="https:\/\/mail\.example\.com\/mail\/reset\?token=abc"/)
assert.match(rendered[1][1], /class="readout em-ink"[^>]*>123456</, 'the code is shown as one unbroken readout')
assert.match(rendered[1][1], /class="readout[^"]*" style="[^"]*letter-spacing:0;[^"]*user-select:all;/, 'the code has no spacing tricks and copies in one go')
assert.match(emails.renderActionEmail({ eyebrow: 'Example · Mail', code: '123 456', title: '123456', body: 'Enter this code.', actionLabel: 'Open', actionUrl: 'https://mail.example.com/mail', expiry: 'Expires in 10 minutes.', footer: 'Not you?' }), />123456</, 'a code passed with a space still shows unbroken')
assert.match(rendered[0][1], /Powered by <a href="https:\/\/vela\.novacraft\.africa"/, 'mailbox mail carries the Vela line')
assert.ok(!rendered[3][1].includes('Powered by'), 'company follow-ups do not')
assert.match(rendered[0][1], /<img src="https:\/\/novacraft\.africa\/vela-mark-email\.png" width="16" height="16" alt="Vela"/, 'the Vela line carries the Vela mark')
assert.match(rendered[0][1], /<img src="[^"]+mark-email\.png" height="32" alt="Example Mail" style="display:block;height:32px;width:auto;/, 'a company logo keeps its own shape')
const logoless = emails.renderAccessEmail({ brand: { ...emails.MAIL_BRAND, markUrl: undefined }, kind: 'invite', product: 'Example Mail', recipient: 'ada@example.org', link: 'https://mail.example.com/mail/reset?token=abc', expiry: '7 days' })
assert.match(logoless.html, /<img src="https:\/\/novacraft\.africa\/vela-mark-email\.png" width="32" height="32" alt="Vela"/, 'a company without a logo gets the Vela mark, never an initial')
assert.ok(!/linear-gradient|radial-gradient/.test(rendered.map(([, html]) => html).join('')), 'no gradients')
assert.ok(!rendered[1][1].includes('href="https://mail.example.com/mail"'), 'a code email has no button')
assert.match(rendered[1][1], /Sent to ada@example\.org because two-step sign-in by email is on/)
assert.match(rendered[0][1], /#0560fa/, 'an rgb() accent is converted for email clients')
assert.equal(emails.templateEnabled('academy', 'academy,contact'), true)

const request = {
  details: { time: 'Fri, 30 Oct 2026, 15:05 GMT+1 (Africa/Lagos)', ip: '198.51.100.9', location: 'Ikeja, Lagos, NG', device: hostile },
  wasntYou: 'Reset your password or ask your mailbox admin:',
  helpUrl: 'https://mail.example.com/mail',
}
const withRequest = emails.renderActionEmail({ eyebrow: 'Example · Mail', code: '123456', title: '123456', body: 'Enter this code.', actionLabel: 'Open', actionUrl: 'https://mail.example.com/mail', expiry: 'Expires in 10 minutes.', footer: 'Not you?', request })
assert.match(withRequest, /Request details/)
assert.match(withRequest, /198\.51\.100\.9/)
assert.match(withRequest, /Ikeja, Lagos, NG/)
assert.match(withRequest, /Africa\/Lagos/)
assert.match(withRequest, /Wasn't you\?/)
assert.ok(!withRequest.includes('<script>'), 'request details are escaped')
assert.ok(!rendered[1][1].includes('Request details'), 'the block appears only when a request is passed')
const access = emails.renderAccessEmail({ brand: emails.MAIL_BRAND, kind: 'reset', product: 'Example Mail', recipient: 'ada@example.org', link: 'https://mail.example.com/mail/reset?token=abc', expiry: '30 minutes', request })
assert.match(access.html, /Request details/)
assert.match(access.text, /IP address: 198\.51\.100\.9\nLocation: Ikeja, Lagos, NG/)
assert.match(emails.withRequestText('Your code is 123456.', request), /^Your code is 123456\.\n\nRequest details\nTime: /)

const linked = emails.renderActionEmail({ eyebrow: 'Example · Mail', code: '123456', title: '123456', body: 'Enter this code.', actionLabel: 'Open Example Mail', actionUrl: 'https://mail.example.com/mail', codeLinkUrl: 'https://mail.example.com/mail/signin?email=ada%40example.com&code=123456', expiry: 'Expires in 10 minutes.', footer: 'Not you?', request: { ...request, devicesUrl: 'https://mail.example.com/mail/security' } })
assert.match(linked, /href="https:\/\/mail\.example\.com\/mail\/signin\?email=ada%40example\.com&amp;code=123456"/, 'a code email opens the code screen with the code filled in')
assert.match(linked, /Open Example Mail/)
assert.match(linked, /href="https:\/\/mail\.example\.com\/mail\/security"[^>]*>Review signed-in devices</)
assert.ok(!rendered[1][1].includes('href="https://mail.example.com/mail/signin'), 'without a link the code email still has no button')

const pale = emails.accentColors('#f5d90a')
assert.equal(pale.accent, '#f5d90a', 'the fill stays the exact accent')
assert.notEqual(pale.accentInk, '#f5d90a', 'text on white gets a darker shade of a pale accent')
assert.equal(pale.buttonText, '#16121f', 'a pale button gets dark label text')
assert.equal(emails.accentColors('#0560fa').buttonText, '#ffffff')

console.log('mailbox emails: ok')
