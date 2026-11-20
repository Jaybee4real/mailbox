import assert from 'node:assert/strict'
import test from 'node:test'
import { formatWait, loadPause, readPause, readThrottle, savePause, scopeWords, secondsLeft } from './pause.ts'

test('waits count down in minutes and seconds to 0:01', () => {
  assert.equal(formatWait(222), '3:42')
  assert.equal(formatWait(60), '1:00')
  assert.equal(formatWait(10), '0:10')
  assert.equal(formatWait(9.2), '0:10')
  assert.equal(formatWait(9), '0:09')
  assert.equal(formatWait(0.2), '0:01')
  assert.equal(formatWait(1), '0:01')
  assert.equal(secondsLeft(10_500, 10_000), 1)
  assert.equal(secondsLeft(5_000, 10_000), 0)
})

test('each scope has its own words', () => {
  assert.equal(scopeWords('device'), 'this device')
  assert.equal(scopeWords('ip'), 'your network')
  assert.equal(scopeWords('account'), 'your account')
})

test("a 429 becomes a pause from Vela's fields, or from Retry-After on an older server", () => {
  const now = Date.parse('2026-10-30T12:00:00.000Z')
  assert.deepEqual(
    readPause(429, '240', { name: 'rate_limited', scope: 'account', retry_after: 240, blocked_until: '2026-10-30T12:04:00.000Z', error: 'Too many' }, now),
    { scope: 'account', blockedUntil: now + 240_000, message: 'Too many' },
  )
  assert.equal(
    readPause(429, null, { scope: 'device', retry_after: 30, blocked_until: '2026-10-30T12:09:00.000Z' }, now)?.blockedUntil,
    now + 30_000,
    "the server's seconds-left wins over its clock time",
  )
  assert.equal(readPause(429, null, { scope: 'device', blocked_until: '2026-10-30T12:02:00.000Z' }, now)?.blockedUntil, now + 120_000)
  assert.deepEqual(readPause(429, '30', { ok: false, error: 'Too many attempts. Try again shortly.' }, now), { scope: 'ip', blockedUntil: now + 30_000, message: 'Too many attempts. Try again shortly.' })
  assert.deepEqual(readPause(429, null, null, now), { scope: 'ip', blockedUntil: now + 60_000, message: '' })
  assert.equal(readPause(401, '30', {}, now), null)
  assert.equal(readThrottle({ ok: true, throttled: true, retry_after: 45 }, now), now + 45_000)
  assert.equal(readThrottle({ ok: true }, now), null)
})

test('a pause survives a reload and clears itself once it has run out', () => {
  const backing = new Map<string, string>()
  const store = { getItem: (key: string) => backing.get(key) ?? null, setItem: (key: string, value: string) => void backing.set(key, value), removeItem: (key: string) => void backing.delete(key) }
  const now = 1_000_000
  savePause(store, 'acme_mail_', 'signin', { scope: 'device', blockedUntil: now + 90_000, message: '' })
  assert.deepEqual(loadPause(store, 'acme_mail_', 'signin', now), { scope: 'device', blockedUntil: now + 90_000, message: '' })
  assert.equal(loadPause(store, 'acme_mail_', 'reset', now), null, 'flows are paused separately')
  assert.equal(loadPause(store, 'acme_mail_', 'signin', now + 91_000), null)
  assert.equal(backing.size, 0, 'an expired pause is removed')
  savePause(store, 'acme_mail_', 'code', { scope: 'ip', blockedUntil: now + 5_000, message: '' })
  savePause(store, 'acme_mail_', 'code', null)
  assert.equal(backing.size, 0)
  assert.equal(loadPause(null, 'acme_mail_', 'code', now), null)
})
