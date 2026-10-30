import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { issueMobileSession, readMobileSession, mobileDevices } from './mobile-session'

test('each phone records the Vela version, build and update it last reported', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vela-app-test-'))
  process.env.DATABASE_URL = `file:${directory}/test.sqlite`
  try {
    const token = await issueMobileSession('carol@example.com', 'fingerprint-c', 'Carol iPhone')
    const req = (app?: string) => new Request('https://mail.example.com', { headers: { authorization: `Bearer ${token}`, ...(app ? { 'x-vela-app': app } : {}) } })
    await readMobileSession(req(JSON.stringify({ version: '1.0', build: '3', update: 'v5', platform: 'ios', os: '18.2' })))
    let [device] = await mobileDevices('carol@example.com')
    assert.deepEqual([device.app_version, device.app_build, device.app_update, device.app_platform, device.os_version], ['1.0', '3', 'v5', 'ios', '18.2'])
    await readMobileSession(req(JSON.stringify({ version: '1.0', build: '3', update: 'v6', platform: 'ios', os: '18.2' })))
    ;[device] = await mobileDevices('carol@example.com')
    assert.equal(device.app_update, 'v6', 'a new update replaces the old label')
    await readMobileSession(req('not json'))
    await readMobileSession(req())
    ;[device] = await mobileDevices('carol@example.com')
    assert.equal(device.app_update, 'v6', 'a missing or malformed header leaves the last report alone')
    await readMobileSession(req(JSON.stringify({ version: '1.0<script>', build: 'x'.repeat(80) })))
    ;[device] = await mobileDevices('carol@example.com')
    assert.equal(device.app_version, '1.0script')
    assert.equal(String(device.app_build).length, 32)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
