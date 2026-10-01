import assert from 'node:assert/strict'

process.env.BRAND_NAME = 'Example'
process.env.MAIL_ADDRESS_DOMAIN = 'example.com'
process.env.BRAND_COLOR_ACCENT = 'rgb(5, 96, 250)'
const emails = await import('./index.ts')

const hostile = '<script>alert(1)</script>'
const rendered: Array<[string, string]> = [
  ['reset', emails.renderActionEmail({ eyebrow: 'Example · Mail', title: 'Reset your password', body: `Someone asked to reset the password for ${hostile}.`, actionLabel: 'Set a new password', actionUrl: 'https://mail.example.com/mail/reset?token=abc', expiry: 'This link expires in 30 minutes.', footer: 'Ignore this if it was not you.' })],
  ['sign-in code', emails.renderActionEmail({ eyebrow: 'Example · Mail', code: '123 456', recipient: 'ada@example.org', reason: 'because two-step sign-in by email is on for your account', title: '123 456', body: 'Enter this code.', actionLabel: 'Open', actionUrl: 'https://mail.example.com/mail', expiry: 'Expires in 10 minutes.', footer: 'Not you? Change your password.' })],
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
assert.match(rendered[1][1], /class="readout em-accent"[^>]*>123 456</, 'the code is shown as a readout')
assert.ok(!rendered[1][1].includes('href="https://mail.example.com/mail"'), 'a code email has no button')
assert.match(rendered[1][1], /Sent to ada@example\.org because two-step sign-in by email is on/)
assert.match(rendered[0][1], /#0560fa/, 'an rgb() accent is converted for email clients')
assert.equal(emails.templateEnabled('academy', 'academy,contact'), true)

console.log('mailbox emails: ok')
