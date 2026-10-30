import assert from 'node:assert/strict'
import { describeRequest, formatRequestTime, nativeAppDevice, visitorContext } from './client-context'
import { emailLayout, emailText, requestPanel, withRequestText, type EmailBrand } from './emails/layout.ts'

const request = (headers: Record<string, string>) => new Request('https://mail.example.com/', { headers })
const moment = new Date('2026-10-30T14:05:00Z')

const browser = visitorContext(request({
  'x-real-ip': '172.70.1.2',
  'cf-connecting-ip': '198.51.100.9',
  'cf-ipcountry': 'NG',
  'cf-region': 'Lagos',
  'cf-ipcity': 'Ikeja',
  'cf-timezone': 'Africa/Lagos',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
}))
const details = describeRequest(browser, { now: moment })
assert.equal(details.ip, '198.51.100.9')
assert.equal(details.location, 'Ikeja, Lagos, NG')
assert.equal(details.device, 'Chrome on macOS')
assert.match(details.time, /30 Oct 2026, 15:05 .*\(Africa\/Lagos\)$/, 'time is shown in the requester\'s timezone')

const direct = describeRequest(visitorContext(request({ 'x-real-ip': '203.0.113.7', 'cf-timezone': 'Europe/Paris' })), { now: moment })
assert.equal(direct.location, null, 'a caller outside Cloudflare cannot pick its location')
assert.match(direct.time, /14:05 UTC$/, 'without a trusted timezone the time is UTC')
assert.match(formatRequestTime(moment, 'Not/AZone'), /14:05 UTC$/, 'an unknown timezone falls back to UTC')

assert.equal(nativeAppDevice('Vela Mail on ios', null), 'Vela Mail on iOS')
assert.equal(nativeAppDevice('Vela Mail on android', null), 'Vela Mail on Android')
assert.equal(nativeAppDevice(null, 'okhttp/4.12.0'), 'Vela Mail on Android')
assert.equal(nativeAppDevice('<b>evil</b>', null), 'Vela Mail app', 'the device header is never echoed')
assert.equal(describeRequest(browser, { native: true, deviceHeader: 'Vela Mail on ios', now: moment }).device, 'Vela Mail on iOS')

const brand: EmailBrand = { name: 'Example Mail', accent: '#0560fa', accentOnDark: '#8fb4ff', tagline: 'Team mail', site: 'mail.example.com', siteUrl: 'https://mail.example.com' }
const hostile = { time: '<script>alert(1)</script>', ip: '"><img src=x>', location: 'Zürich & <b>', device: '<i>Chrome</i>' }
const notice = { details: hostile, wasntYou: 'Reset it <now>:', helpUrl: 'https://mail.example.com/mail' }
const panel = requestPanel(notice)
assert.ok(!/<script>|<img|<b>|<i>|<now>/.test(panel), 'every value is escaped')
assert.match(panel, /Request details/)
assert.match(panel, /Wasn't you\?/)
assert.match(panel, /href="https:\/\/mail\.example\.com\/mail"/)
assert.ok(!requestPanel({ ...notice, helpUrl: 'javascript:alert(1)' }).includes('javascript:'), 'only http(s) links are kept')

const html = emailLayout({ brand, eyebrow: 'Account', heading: 'Reset your password', bodyHtml: '<p>Hi</p>', request: { ...notice, details } })
for (const value of [details.time, details.ip, details.location, details.device]) assert.ok(html.includes(value!), `html shows ${value}`)

const unknown = { details: { time: details.time, ip: null, location: null, device: 'Browser' }, wasntYou: 'Tell your mailbox admin.' }
const text = emailText({ brand, heading: 'Reset your password', paragraphs: ['Hi'], request: unknown })
assert.match(text, /Request details\nTime: .+\nIP address: Unknown\nLocation: Unknown\nDevice: Browser\n\nWasn't you\? Tell your mailbox admin\./)
assert.equal(
  withRequestText('Your code is 123 456.', { ...unknown, helpUrl: 'https://mail.example.com/mail' }),
  `Your code is 123 456.\n\nRequest details\nTime: ${details.time}\nIP address: Unknown\nLocation: Unknown\nDevice: Browser\n\nWasn't you? Tell your mailbox admin. https://mail.example.com/mail`,
)

console.log('request details: time, IP, location and device on every account email, escaped')
