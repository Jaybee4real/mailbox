import assert from 'node:assert/strict'
import test from 'node:test'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1'
const IPHONE_FIREFOX =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15'
const IPAD_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const MAC_SAFARI = IPAD_SAFARI
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

test('the install guide is offered on iOS and nowhere else', async () => {
  const { classifyIos } = await import('./pwa.ts')

  assert.equal(classifyIos(IPHONE_SAFARI, 5), 'safari')
  assert.equal(classifyIos(IPAD_SAFARI, 5), 'safari', 'iPadOS reports a Mac agent; touch points separate it')

  assert.equal(classifyIos(IPHONE_CHROME, 5), 'other')
  assert.equal(classifyIos(IPHONE_FIREFOX, 5), 'other')

  assert.equal(classifyIos(MAC_SAFARI, 0), null, 'a desktop Mac is not an install candidate')
  assert.equal(classifyIos(ANDROID_CHROME, 5), null, 'Android has beforeinstallprompt already')
  assert.equal(classifyIos(DESKTOP_CHROME, 0), null)
})
