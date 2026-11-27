import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLabel, isNewerBuild } from './build-info'

test('the label shows the build number and the short commit', () => {
  assert.equal(buildLabel('324', '6c69b0a1f2e3d4c5b6a7'), 'Build 324 · 6c69b0a')
  assert.equal(buildLabel('', '6c69b0a1f2e3'), '6c69b0a')
  assert.equal(buildLabel('', ''), 'dev')
})

test('a different served commit is a newer build', () => {
  assert.equal(isNewerBuild('aaa111', 'bbb222'), true)
  assert.equal(isNewerBuild('aaa111', 'aaa111'), false)
})

test('a failed or empty answer, or an unknown running build, never counts as newer', () => {
  assert.equal(isNewerBuild('aaa111', ''), false)
  assert.equal(isNewerBuild('aaa111', null), false)
  assert.equal(isNewerBuild('aaa111', undefined), false)
  assert.equal(isNewerBuild('', 'bbb222'), false)
})
