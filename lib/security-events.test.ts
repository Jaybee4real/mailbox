import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

const watchedAccount = 'k.watch@example.com'
const watchedContact = 'canary@example.com'
const retiredToken = `vm_${'A'.repeat(43)}`
const watchedPath = '/api/mail/admin/export'
const digest = (value: string) => createHash('sha256').update(value.trim().toLowerCase()).digest('hex')

process.env.DATABASE_URL = 'file::memory:'
process.env.MAIL_ADDRESS_DOMAIN = 'example.com'
process.env.MAIL_SEATS = '[]'
process.env.MAIL_SESSION_SECRET = 'test-session-secret'
process.env.SECURITY_WATCH = [watchedAccount, watchedContact, retiredToken, watchedPath].map(digest).join(',')

type Received = { authorization?: string; body: Record<string, unknown> }

async function collector() {
  const received: Received[] = []
  const server = createServer((req: IncomingMessage, res) => {
    let raw = ''
    req.on('data', chunk => (raw += chunk))
    req.on('end', () => {
      received.push({ authorization: req.headers.authorization, body: JSON.parse(raw) })
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { received, url: `http://127.0.0.1:${port}/report`, close: () => server.close() }
}

async function settle(received: Received[], count: number) {
  for (let attempt = 0; attempt < 50 && received.length < count; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
}

test('nothing is sent while the reporting settings are missing', async () => {
  const { reportSecurityEvent } = await import('./security-events.ts')
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('{}')
  }) as typeof fetch
  try {
    await reportSecurityEvent(new Request('https://mail.example.com/api/mail/login'), { level: 3, kind: 'honey-account', detail: 'test' })
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls, 0)
})

test('a report the endpoint refuses is logged', async () => {
  const { reportSecurityEvent } = await import('./security-events.ts')
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  process.env.SECURITY_EVENTS_URL = 'https://events.example.com/report'
  process.env.SECURITY_EVENTS_TOKEN = 'report-token'
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch
  console.warn = (...args: unknown[]) => void warnings.push(args)
  try {
    await reportSecurityEvent(new Request('https://mail.example.com/api/mail/login'), { level: 3, kind: 'honey-account', detail: 'test' })
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    delete process.env.SECURITY_EVENTS_URL
    delete process.env.SECURITY_EVENTS_TOKEN
  }
  assert.deepEqual(warnings, [['[security-events]', 'report answered 404']])
})

test('the watched account cannot sign in even with its real password, and every attempt is reported', async () => {
  const sink = await collector()
  process.env.SECURITY_EVENTS_URL = sink.url
  process.env.SECURITY_EVENTS_TOKEN = 'report-token'
  try {
    const { createAccount, setAccountPassword } = await import('./mailbox.ts')
    const { hashPassword } = await import('./password.ts')
    const { verifyMailAuth } = await import('./dev-auth.ts')
    await createAccount({ email: watchedAccount, address: watchedAccount, name: 'Kabir Watch' })
    await setAccountPassword(watchedAccount, await hashPassword('the-real-password'))

    const result = await verifyMailAuth(watchedAccount, 'the-real-password')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'Invalid credentials')

    const { POST } = await import('../app/api/mail/login/route.ts')
    const response = await POST(new Request('https://mail.example.com/api/mail/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'probe/1.0', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ email: watchedAccount, password: 'guess' }),
    }))
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { ok: false, error: 'Email or password is incorrect.' })

    await settle(sink.received, 1)
    const [report] = sink.received
    assert.equal(report.authorization, 'Bearer report-token')
    assert.equal(report.body.product, 'vela-mail')
    assert.equal(report.body.level, 3)
    assert.equal(report.body.kind, 'honey-account')
    assert.equal(report.body.path, '/api/mail/login')
    assert.equal(report.body.userAgent, 'probe/1.0')
    assert.ok(!JSON.stringify(report.body).includes('guess'), 'the typed password never leaves the server')
  } finally {
    sink.close()
    delete process.env.SECURITY_EVENTS_URL
    delete process.env.SECURITY_EVENTS_TOKEN
  }
})

test('a session minted for the watched account opens nothing', async () => {
  const { issueSession, passwordFingerprint, SESSION_COOKIE } = await import('./session.ts')
  const { getAccountPasswordHash } = await import('./mailbox.ts')
  const { authenticate } = await import('./dev-auth.ts')
  const token = issueSession(watchedAccount, passwordFingerprint(await getAccountPasswordHash(watchedAccount)))
  const viewer = await authenticate(new Request('https://mail.example.com/api/mail/threads', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }))
  assert.equal(viewer, null)
})

test('the retired token is refused like any unknown token and reported', async () => {
  const sink = await collector()
  process.env.SECURITY_EVENTS_URL = sink.url
  process.env.SECURITY_EVENTS_TOKEN = 'report-token'
  try {
    const { authenticate } = await import('./dev-auth.ts')
    const viewer = await authenticate(new Request('https://mail.example.com/api/mail/threads', { headers: { authorization: `Bearer ${retiredToken}` } }))
    assert.equal(viewer, null)
    await settle(sink.received, 1)
    assert.equal(sink.received[0]?.body.kind, 'decoy-key')
    assert.equal(sink.received[0]?.body.level, 2)
  } finally {
    sink.close()
    delete process.env.SECURITY_EVENTS_URL
    delete process.env.SECURITY_EVENTS_TOKEN
  }
})

test('watched accounts and contacts stay out of every list people see', async () => {
  const { createAccount, listAccounts, recordContact, searchContacts } = await import('./mailbox.ts')
  await createAccount({ email: 'ada@example.com', address: 'ada@example.com', name: 'Ada' })
  await recordContact(watchedContact, 'Ifeoma Canary')
  await recordContact('real.person@example.com', 'Real Person')

  const accounts = (await listAccounts()).map(account => account.email)
  assert.ok(accounts.includes('ada@example.com'))
  assert.ok(!accounts.includes(watchedAccount))

  const everyone = (await searchContacts('')).map(contact => contact.email)
  assert.ok(everyone.includes('real.person@example.com'))
  assert.ok(!everyone.includes(watchedContact))
  assert.deepEqual(await searchContacts('canary'), [])
})
