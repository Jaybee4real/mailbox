import assert from 'node:assert/strict'
import { clientIp, originHeaders, visitorContext } from './client-context'

const request = (headers: Record<string, string>) => new Request('https://mail.example.com/', { headers })

const viaCloudflare = request({
  'x-real-ip': '172.70.1.2',
  'x-forwarded-for': '172.70.1.2',
  'cf-connecting-ip': '198.51.100.9',
  'cf-ipcountry': 'NG',
  'cf-region': 'Lagos',
  'cf-ipcity': 'Ikeja',
  'cf-timezone': 'Africa/Lagos',
  'accept-language': 'en-GB,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
})
const context = visitorContext(viaCloudflare)
assert.equal(context.ip, '198.51.100.9')
assert.equal(context.city, 'Ikeja')
assert.equal(context.language, 'en-GB')

const spoofed = visitorContext(request({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7', 'cf-connecting-ip': '1.1.1.1', 'cf-ipcity': 'Paris' }))
assert.equal(spoofed.ip, '203.0.113.7', 'a direct caller cannot choose its own address')
assert.equal(spoofed.city, null, 'nor its own location')
assert.equal(clientIp(request({})), null)

const headers = originHeaders({ ...context, city: 'Zürich\r\nBcc: victim@example.com' })
assert.equal(headers['X-Originating-IP'], '[198.51.100.9]')
assert.ok(!/[\r\n]/.test(Object.values(headers).join('')), 'no header injection')
assert.match(headers['X-Sender-Location'], /^Zurich Bcc: victim@example\.com, Lagos, NG \(Africa\/Lagos\)$/)
assert.ok(headers['X-Sender-Device'].length > 0)

console.log('client-context: Cloudflare-only trust, location, and injection-safe origin headers')
