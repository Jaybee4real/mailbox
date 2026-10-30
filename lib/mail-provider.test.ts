import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { providerConfigProblem, velaSendBody } from './mail-provider.ts'

const directory = mkdtempSync(join(tmpdir(), 'provider-test-'))
process.env.DATABASE_URL = `file:${directory}/test.sqlite`
after(() => rmSync(directory, { recursive: true, force: true }))

test('sending is configured by VELA_API_URL and VELA_API_KEY alone', () => {
  delete process.env.VELA_API_URL
  delete process.env.VELA_API_KEY
  assert.match(providerConfigProblem() ?? '', /VELA_API_URL/)
  process.env.VELA_API_URL = 'https://vela.example.com'
  assert.match(providerConfigProblem() ?? '', /VELA_API_KEY/)
  process.env.VELA_API_KEY = 'vela_test'
  assert.equal(providerConfigProblem(), null)
})

test('the Vela body carries attachments, inline parts, headers and the request context', () => {
  const body = velaSendBody({
    from: 'info@example.com',
    fromName: 'Example <Mail>',
    to: ['ada@example.org'],
    cc: ['ops@example.org'],
    replyTo: 'reply@example.com',
    subject: 'Hello',
    html: '<p>Hi <img src="cid:logo@example"></p>',
    text: 'Hi',
    headers: { 'In-Reply-To': '<abc@example.com>' },
    attachments: [
      { filename: 'report.pdf', content: 'JVBE\nRi0=', contentType: 'application/pdf' },
      { filename: 'logo.png', content: 'iVBORw0KGgo=', contentType: 'image/png', contentId: '<logo@example>' },
    ],
    context: { purpose: 'login_code', ip: '198.51.100.9', device: 'web:abcdefghijklmnop', account: 'ada@example.com', user_agent: null },
  })
  assert.equal(body.from, 'Example Mail <info@example.com>')
  assert.equal(body.reply_to, 'reply@example.com')
  assert.deepEqual(body.headers, { 'In-Reply-To': '<abc@example.com>' })
  assert.deepEqual(body.attachments, [
    { filename: 'report.pdf', content: 'JVBERi0=', content_type: 'application/pdf' },
    { filename: 'logo.png', content: 'iVBORw0KGgo=', content_type: 'image/png', content_id: 'logo@example' },
  ])
  assert.deepEqual(body.context, { purpose: 'login_code', ip: '198.51.100.9', device: 'web:abcdefghijklmnop', account: 'ada@example.com' })
  assert.equal(velaSendBody({ from: 'a@example.com', to: ['b@example.com'], subject: 's', text: '' }).text, ' ')
})

test('sendMail posts to Vela and reads throttled and rate-limited answers', async () => {
  process.env.VELA_API_URL = 'https://vela.example.com/api/v1/'
  process.env.VELA_API_KEY = 'vela_test'
  const { sendMail } = await import('./mail-provider.ts')
  const { VelaRateLimitError } = await import('./vela.ts')
  let answer: Response = new Response(JSON.stringify({ id: 'msg_1' }))
  const seen: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/suppressions/check')) return new Response(JSON.stringify({ data: [] }))
    seen.push(url)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer vela_test')
    return answer.clone()
  }
  const payload = { from: 'info@example.com', to: ['ada@example.org'], subject: 'Code', text: '123 456' }
  assert.deepEqual(await sendMail(payload), { id: 'msg_1' })
  assert.deepEqual(seen, ['https://vela.example.com/api/v1/emails'])

  answer = new Response(JSON.stringify({ id: null, throttled: true, reason: 'recipient_cooldown', retry_after: 45 }))
  assert.deepEqual(await sendMail(payload), { id: null, throttled: true, retryAfter: 45 })

  answer = new Response(
    JSON.stringify({ name: 'rate_limited', message: 'Too many requests. Try again in 4 minutes.', scope: 'ip', retry_after: 240, blocked_until: '2026-10-30T12:04:00.000Z' }),
    { status: 429, headers: { 'retry-after': '240' } },
  )
  await assert.rejects(sendMail(payload), (err: unknown) => {
    assert.ok(err instanceof VelaRateLimitError)
    assert.equal(err.scope, 'ip')
    assert.equal(err.retryAfter, 240)
    assert.equal(err.blockedUntil, '2026-10-30T12:04:00.000Z')
    return true
  })

  answer = new Response(JSON.stringify({ name: 'rate_limit_exceeded', message: 'Key quota reached' }), { status: 429 })
  await assert.rejects(sendMail(payload), /Key quota reached/, "a key's own quota is a send failure, not a requester block")
})
