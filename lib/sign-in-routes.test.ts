import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const directory = mkdtempSync(join(tmpdir(), 'sign-in-routes-test-'))
process.env.DATABASE_URL = `file:${directory}/test.sqlite`
process.env.MAIL_ADDRESS_DOMAIN = 'example.com'
process.env.MAIL_SEATS = '[]'
process.env.MAIL_SESSION_SECRET = 'test-session-secret'
process.env.TURNSTILE_SECRET_KEY = 'test-turnstile-secret'
after(() => rmSync(directory, { recursive: true, force: true }))

const PASSWORD = 'correct horse battery staple'
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  if (String(input).includes('challenges.cloudflare.com')) {
    const token = (init?.body as URLSearchParams).get('response')
    return new Response(JSON.stringify({ success: token === 'pass' }))
  }
  return realFetch(input, init)
}

let ipCounter = 0
const freshIp = () => `198.51.100.${++ipCounter}`
const BROWSER = { origin: 'https://mail.example.com', 'sec-fetch-mode': 'cors' }
const NATIVE = { 'x-mail-client': 'vela-native' }

function post(path: string, options: { ip: string; headers?: Record<string, string>; body?: unknown }) {
  return new Request(`https://mail.example.com${path}`, {
    method: 'POST',
    headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), 'x-real-ip': options.ip, ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function routes() {
  const login = await import('../app/api/mail/login/route.ts')
  const verify = await import('../app/api/mail/login/verify/route.ts')
  const emailCode = await import('../app/api/mail/login/email-code/route.ts')
  const requestReset = await import('../app/api/mail/request-reset/route.ts')
  const reset = await import('../app/api/mail/reset/route.ts')
  const mailbox = await import('./mailbox.ts')
  const { hashPassword } = await import('./password.ts')
  const { newChallengeId } = await import('./two-factor.ts')
  return { login: login.POST, verify: verify.POST, emailCode: emailCode.POST, requestReset: requestReset.POST, reset: reset.POST, mailbox, hashPassword, newChallengeId }
}

async function account(email: string, address = email) {
  const { mailbox, hashPassword } = await routes()
  await mailbox.createAccount({ email, address, status: 'active' })
  await mailbox.setAccountPassword(email, await hashPassword(PASSWORD))
}

function assertThrottled(response: Response) {
  assert.equal(response.status, 429)
  const retryAfter = Number(response.headers.get('retry-after'))
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0, `Retry-After is whole seconds, got ${retryAfter}`)
}

test('login takes the credentials from a JSON body, still honours the legacy headers, and never echoes the password', async () => {
  const { login, mailbox } = await routes()
  await account('body@example.com')

  const wrong = await login(post('/api/mail/login', { ip: freshIp(), headers: BROWSER, body: { email: 'body@example.com', password: 'nope', turnstile: 'pass' } }))
  assert.equal(wrong.status, 401)
  assert.deepEqual(await wrong.json(), { ok: false, error: 'Email or password is incorrect.' })

  const viaBody = await login(post('/api/mail/login', { ip: freshIp(), headers: BROWSER, body: { email: 'Body@Example.com', password: PASSWORD, turnstile: 'pass' } }))
  const bodyText = await viaBody.text()
  assert.equal(viaBody.status, 200)
  assert.deepEqual(JSON.parse(bodyText), { ok: true, email: 'body@example.com', session: true })
  assert.ok(viaBody.headers.get('set-cookie'), 'a browser gets the session cookie')
  assert.ok(!bodyText.includes(PASSWORD) && !(viaBody.headers.get('set-cookie') ?? '').includes(PASSWORD))

  const headerOnly = await login(post('/api/mail/login', {
    ip: freshIp(),
    headers: { ...BROWSER, 'content-type': 'application/json', 'x-dev-email': 'body@example.com', 'x-dev-password': PASSWORD, 'x-turnstile': 'pass' },
  }))
  assert.equal(headerOnly.status, 400, 'credentials in headers are not read')

  const native = await login(post('/api/mail/login', {
    ip: freshIp(),
    headers: { ...NATIVE, 'x-mail-device': 'Vela Mail on ios' },
    body: { email: 'body@example.com', password: PASSWORD },
  }))
  const nativeData = await native.json()
  assert.equal(native.status, 200, 'Vela builds sign in with the body')
  assert.match(nativeData.token, /^vm_/)
  assert.ok(!JSON.stringify(nativeData).includes(PASSWORD))

  const signins = await mailbox.listSignins('body@example.com')
  assert.equal(signins[0].client, 'vela-native', 'the bypass is recorded with the client marker')
  assert.equal(signins[1].client, null)
  assert.ok(signins.every(entry => !JSON.stringify(entry).includes(PASSWORD)))
})

test('a page cannot claim to be the native app to skip Turnstile', async () => {
  const { login } = await routes()
  await account('spoof@example.com')
  for (const marker of [{ origin: 'https://evil.example' }, { 'sec-fetch-mode': 'cors' }] as Record<string, string>[]) {
    const response = await login(post('/api/mail/login', { ip: freshIp(), headers: { ...NATIVE, ...marker }, body: { email: 'spoof@example.com', password: PASSWORD } }))
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { ok: false, human: false, error: 'Complete the human check and try again' })
  }
})

test('the native bypass meets a per-IP and a per-address ceiling that browsers do not', async () => {
  const { login } = await routes()
  const ip = freshIp()
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await login(post('/api/mail/login', { ip, headers: NATIVE, body: { email: `spray${attempt}@example.com`, password: 'guess' } }))
    assert.equal(response.status, 401)
  }
  assertThrottled(await login(post('/api/mail/login', { ip, headers: NATIVE, body: { email: 'spray-next@example.com', password: 'guess' } })))

  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await login(post('/api/mail/login', { ip: freshIp(), headers: NATIVE, body: { email: 'target@example.com', password: 'guess' } }))
    assert.equal(response.status, 401)
  }
  const rotated = await login(post('/api/mail/login', { ip: freshIp(), headers: NATIVE, body: { email: 'target@example.com', password: 'guess' } }))
  assertThrottled(rotated)
  assert.deepEqual(await rotated.json(), { ok: false, error: 'Too many attempts. Try again shortly.' })

  const browser = await login(post('/api/mail/login', { ip: freshIp(), headers: BROWSER, body: { email: 'target@example.com', password: 'guess', turnstile: 'pass' } }))
  assert.equal(browser.status, 401, 'a browser that solved Turnstile is not held to the native ceiling')
})

test('native successes do not use up the native budget, so a shared office IP keeps signing in', async () => {
  const { login } = await routes()
  await account('office@example.com')
  const ip = freshIp()
  for (let count = 0; count < 25; count++) {
    const response = await login(post('/api/mail/login', { ip, headers: NATIVE, body: { email: 'office@example.com', password: PASSWORD } }))
    assert.equal(response.status, 200)
  }
})

test('a third party cannot lock a person out of the app: success clears their native address budget', async () => {
  const { login } = await routes()
  await account('victim@example.com')
  const wrong = () => login(post('/api/mail/login', { ip: freshIp(), headers: NATIVE, body: { email: 'victim@example.com', password: 'guess' } }))
  for (let count = 0; count < 9; count++) assert.equal((await wrong()).status, 401)
  const right = await login(post('/api/mail/login', { ip: freshIp(), headers: NATIVE, body: { email: 'victim@example.com', password: PASSWORD } }))
  assert.equal(right.status, 200)
  for (let count = 0; count < 9; count++) assert.equal((await wrong()).status, 401)
})

test('the account email and the mailbox address share one per-account budget', async () => {
  const { login } = await routes()
  await account('kate@outside.test', 'kate@example.com')
  for (let count = 0; count < 10; count++) {
    const email = count % 2 ? 'kate@outside.test' : 'kate@example.com'
    assert.equal((await login(post('/api/mail/login', { ip: freshIp(), headers: NATIVE, body: { email, password: 'guess' } }))).status, 401)
  }
  assertThrottled(await login(post('/api/mail/login', { ip: freshIp(), headers: NATIVE, body: { email: 'kate@example.com', password: 'guess' } })))
})

test('a cross-site page cannot post sign-in or reset forms', async () => {
  const { login, verify, emailCode, requestReset, reset } = await routes()
  await account('csrf@example.com')
  const formBody = JSON.stringify({ email: 'csrf@example.com', password: PASSWORD, challenge: 'x', token: 'x', pad: '=' })
  for (const [handler, path] of [[login, 'login'], [verify, 'login/verify'], [emailCode, 'login/email-code'], [requestReset, 'request-reset'], [reset, 'reset']] as const) {
    const plain = await handler(new Request(`https://mail.example.com/api/mail/${path}`, {
      method: 'POST', headers: { 'content-type': 'text/plain', 'x-real-ip': freshIp() }, body: formBody,
    }))
    assert.equal(plain.status, 415, `${path}: text/plain is refused`)
    assert.equal(plain.headers.get('set-cookie'), null)
    const crossSite = await handler(post(`/api/mail/${path}`, { ip: freshIp(), headers: { 'sec-fetch-site': 'cross-site' }, body: JSON.parse(formBody) }))
    assert.equal(crossSite.status, 403, `${path}: a cross-site fetch is refused`)
  }
})

test('login is limited per IP and address, with Retry-After', async () => {
  const { login } = await routes()
  const ip = freshIp()
  const attempt = () => login(post('/api/mail/login', { ip, headers: BROWSER, body: { email: 'typo@example.com', password: 'guess', turnstile: 'pass' } }))
  for (let count = 0; count < 10; count++) assert.equal((await attempt()).status, 401)
  assertThrottled(await attempt())
  const otherAddress = await login(post('/api/mail/login', { ip, headers: BROWSER, body: { email: 'colleague@example.com', password: 'guess', turnstile: 'pass' } }))
  assert.equal(otherAddress.status, 401, 'a colleague on the same IP is not locked out')
})

test('login/email-code is limited per IP and challenge, with Retry-After', async () => {
  const { emailCode, newChallengeId } = await routes()
  const ip = freshIp()
  const [challengeA, challengeB] = [newChallengeId(), newChallengeId()]
  const send = (requestIp: string, challenge: string) => emailCode(post('/api/mail/login/email-code', { ip: requestIp, headers: NATIVE, body: { challenge } }))
  for (let count = 0; count < 8; count++) assert.equal((await send(ip, challengeA)).status, 401)
  const throttled = await send(ip, challengeA)
  assertThrottled(throttled)
  assert.deepEqual(await throttled.json(), { ok: false, error: 'Too many attempts. Try again shortly.' })
  assert.equal((await send(ip, challengeB)).status, 401, 'another sign-in from the same IP is unaffected')
  assert.equal((await send(freshIp(), challengeA)).status, 401, 'another IP is unaffected')
})

test('login/verify counts wrong codes per IP and per account, and a burst cannot exceed the attempt cap', async () => {
  const { verify, mailbox, newChallengeId } = await routes()
  const send = (ip: string, challenge: string) => verify(post('/api/mail/login/verify', { ip, headers: NATIVE, body: { challenge, method: 'authenticator', code: '000000' } }))

  const ip = freshIp()
  for (let count = 0; count < 20; count++) assert.equal((await send(ip, newChallengeId())).status, 401)
  assertThrottled(await send(ip, newChallengeId()))
  assert.equal((await send(freshIp(), newChallengeId())).status, 401, 'another IP is unaffected')
  assert.equal((await send(freshIp(), 'x'.repeat(1_000_000))).status, 401, 'an oversized challenge is refused as expired')

  await account('burst@example.com')
  const challenge = newChallengeId()
  await mailbox.createLoginChallenge(challenge, 'burst@example.com', 'signin', 10 * 60 * 1000)
  const burstIp = freshIp()
  const replies = await Promise.all(Array.from({ length: 20 }, () => send(burstIp, challenge).then(response => response.json())))
  assert.equal(replies.filter(reply => reply.error === 'That code is not right. Check it and try again.').length, 4)
  const wrongCodes = (await mailbox.listSignins('burst@example.com')).filter(entry => entry.outcome === 'wrong-code')
  assert.equal(wrongCodes.length, 5, 'only five guesses are ever evaluated against one challenge')

  for (let round = 0; round < 3; round++) {
    const next = newChallengeId()
    await mailbox.createLoginChallenge(next, 'burst@example.com', 'signin', 10 * 60 * 1000)
    for (let count = 0; count < 5; count++) assert.equal((await send(freshIp(), next)).status, 401)
  }
  const last = newChallengeId()
  await mailbox.createLoginChallenge(last, 'burst@example.com', 'signin', 10 * 60 * 1000)
  assertThrottled(await send(freshIp(), last))
})

test('a resend inside the cooldown says when to try again', async () => {
  const { emailCode, mailbox, newChallengeId } = await routes()
  const challenge = newChallengeId()
  await account('codes@example.com')
  await mailbox.setRecoveryEmail('codes@example.com', 'codes@outside.example')
  await mailbox.markRecoveryVerified('codes@example.com', 'codes@outside.example')
  await mailbox.setEmailCodes('codes@example.com', true)
  await mailbox.createLoginChallenge(challenge, 'codes@example.com', 'signin', 10 * 60 * 1000)
  await mailbox.setChallengeCode(challenge, 'hash')
  const response = await emailCode(post('/api/mail/login/email-code', { ip: freshIp(), headers: NATIVE, body: { challenge } }))
  assertThrottled(response)
  assert.ok(Number(response.headers.get('retry-after')) <= 60)
  assert.deepEqual(await response.json(), { ok: false, error: 'A code was just sent. Wait a minute before asking for another.' })
})

test('request-reset gives a message to show, flags needsAdmin, and does not tell known from unknown', async () => {
  const { requestReset } = await routes()
  await account('nobackup@example.com')
  const ask = (email: string, ip = freshIp()) => requestReset(post('/api/mail/request-reset', { ip, headers: BROWSER, body: { email, turnstile: 'pass' } }))

  const known = await ask('nobackup@example.com')
  const unknown = await ask('ghost@example.com')
  assert.equal(known.status, 200)
  const knownBody = await known.json()
  assert.deepEqual(knownBody, {
    ok: true,
    needsAdmin: true,
    message: 'No confirmed recovery address is set for that mailbox. Ask an administrator of your workspace to reset it for you.',
  })
  assert.deepEqual(await unknown.json(), knownBody)

  const empty = await ask('  ')
  assert.equal(empty.status, 400)
  assert.deepEqual(await empty.json(), { ok: false, error: 'Enter your email address.' })

  const ip = freshIp()
  for (let count = 0; count < 5; count++) assert.equal((await ask('ghost-two@example.com', ip)).status, 200)
  assertThrottled(await ask('ghost-two@example.com', ip))
  assert.equal((await ask('ghost-three@example.com', ip)).status, 200, 'the limit is per IP and address')

  for (let count = 0; count < 5; count++) assert.equal((await ask('popular@example.com')).status, 200)
  assertThrottled(await ask('popular@example.com'))
})

test('the native bypass on request-reset is no stricter than the browser per address', async () => {
  const { requestReset } = await routes()
  const ask = (ip: string) => requestReset(post('/api/mail/request-reset', { ip, headers: NATIVE, body: { email: 'native-reset@example.com' } }))
  for (let count = 0; count < 5; count++) assert.equal((await ask(freshIp())).status, 200)
  assertThrottled(await ask(freshIp()))
})
