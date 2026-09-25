import assert from 'node:assert/strict'
import test from 'node:test'
import { fittedScale } from './scale.ts'

test('a larger size is held to what the window can fit', () => {
  assert.equal(fittedScale(110, 1440, 790), 110, 'a MacBook Air browser window takes Large')
  assert.equal(fittedScale(125, 1440, 790), 125)
  assert.equal(fittedScale(140, 1440, 790), 131, 'but not 140%: it would leave under 600px of height')
  assert.equal(fittedScale(110, 1366, 650), 108, 'a 1366x768 laptop is held just short of Large')
})

test('smaller sizes and 100% are always allowed', () => {
  assert.equal(fittedScale(90, 800, 500), 90)
  assert.equal(fittedScale(100, 1024, 600), 100)
  assert.equal(fittedScale(125, 390, 844), 100, 'a phone keeps its own layout at 100%')
  assert.equal(fittedScale(110, 0, 0), 110, 'before the window is known')
})
