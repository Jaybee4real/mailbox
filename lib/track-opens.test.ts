import assert from 'node:assert/strict'
import { shouldTrackOpens } from './email-html.ts'

assert.equal(shouldTrackOpens(undefined, true), true)
assert.equal(shouldTrackOpens(undefined, false), false)
assert.equal(shouldTrackOpens(null, true), true)
assert.equal(shouldTrackOpens(null, false), false)
assert.equal(shouldTrackOpens(true, false), true)
assert.equal(shouldTrackOpens(false, true), false)
assert.equal(shouldTrackOpens('false', true), true)

console.log('track-opens ok')
