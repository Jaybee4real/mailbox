import assert from 'node:assert/strict'
import { parseShareSettings, shareGate, viewableType, type ShareCounters } from './share-policy'

const now = Date.parse('2026-10-06T12:00:00Z')
const hour = 3_600_000

assert.equal(viewableType('report.PDF'), 'application/pdf')
assert.equal(viewableType('page.html'), null)
assert.equal(viewableType('logo.svg'), null)

const legacy = parseShareSettings({ expiresInDays: 30, maxDownloads: 3 }, 'big.zip', now)
assert.equal(legacy.settings?.expiresAt, new Date(now + 30 * 24 * hour).toISOString())
assert.equal(legacy.settings?.maxDownloads, 3)
assert.equal(legacy.settings?.access, 'download')

const full = parseShareSettings(
  { expiresAt: new Date(now + 48 * hour).toISOString(), availableAt: new Date(now + hour).toISOString(), maxViews: '5', access: 'view' },
  'deck.pdf',
  now,
)
assert.equal(full.settings?.maxViews, 5)
assert.equal(full.settings?.access, 'view')
assert.equal(full.settings?.availableAt, new Date(now + hour).toISOString())

assert.equal(parseShareSettings({ availableAt: new Date(now - hour).toISOString() }, 'a.pdf', now).settings?.availableAt, null)
assert.ok(parseShareSettings({ access: 'view' }, 'archive.zip', now).error)
assert.equal(parseShareSettings({ access: 'both' }, 'archive.zip', now).settings?.access, 'download')
assert.ok(parseShareSettings({ maxViews: 1.5 }, 'a.pdf', now).error)
assert.ok(parseShareSettings({ maxDownloads: -1 }, 'a.pdf', now).error)
assert.ok(parseShareSettings({ expiresAt: new Date(now - hour).toISOString() }, 'a.pdf', now).error)
assert.ok(parseShareSettings({ expiresAt: new Date(now + hour).toISOString(), availableAt: new Date(now + 2 * hour).toISOString() }, 'a.pdf', now).error)
assert.ok(parseShareSettings({ access: 'everything' }, 'a.pdf', now).error)

const base: ShareCounters = {
  filename: 'deck.pdf',
  revoked: false,
  downloads: 0,
  views: 0,
  expiresAt: null,
  availableAt: null,
  maxDownloads: null,
  maxViews: null,
  access: 'both',
}
assert.deepEqual(shareGate(base, now), { state: 'open', canView: true, canDownload: true })
assert.equal(shareGate({ ...base, availableAt: new Date(now + hour).toISOString() }, now).state, 'pending')
assert.equal(shareGate({ ...base, expiresAt: new Date(now - hour).toISOString() }, now).state, 'gone')
assert.equal(shareGate({ ...base, revoked: true }, now).state, 'gone')
assert.deepEqual(shareGate({ ...base, access: 'view' }, now), { state: 'open', canView: true, canDownload: false })
assert.deepEqual(shareGate({ ...base, maxViews: 2, views: 2 }, now), { state: 'open', canView: false, canDownload: true })
assert.equal(shareGate({ ...base, access: 'view', maxViews: 2, views: 2 }, now).state, 'gone')
assert.equal(shareGate({ ...base, filename: 'a.zip', access: 'download', maxDownloads: 1, downloads: 1 }, now).state, 'gone')
assert.equal(shareGate({ ...base, filename: 'a.zip', access: 'both' }, now).canView, false)

console.log('share-policy: all assertions passed')
