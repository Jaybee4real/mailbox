import assert from 'node:assert/strict'
import test from 'node:test'
import { mixedScriptWord, similarity, skeleton, unicodeHost } from './lookalike.ts'
import { impersonationReasons, judgeMessage, lookalikeOf, raiseRisk } from './risk.ts'

const metroperil = ['metroperilinsbrokers.com']
const novacraft = ['contact.novacraft.africa', 'novacraft.africa']
const stranger = { received: 0, trashed: 0, markedSpam: 0, replied: 0, trusted: false, firstSeen: null }

test('similarity is one minus the edits over the longer length', () => {
  assert.equal(similarity('metroperilinsbrokers', 'metroperilinsbrokers'), 1)
  assert.equal(similarity('metroperilinsbrokers', 'metroperllinsbrokers'), 0.95)
  assert.equal(similarity('abc', 'xyz'), 0)
})

test('look-alike letters collapse onto the letters they imitate', () => {
  assert.equal(skeleton('rnetroperilinsbrokers'), 'metroperilinsbrokers')
  assert.equal(skeleton('vvorld'), 'world')
  assert.equal(skeleton('g00gle'), 'google')
  assert.equal(skeleton('paypa1'), 'paypal')
  assert.equal(skeleton('PaypaI'), 'paypal')
  assert.equal(skeleton('pаypаl'), 'paypal', 'Cyrillic а reads as a')
  assert.equal(skeleton('ροlο'), 'polo', 'Greek ρ and ο read as p and o')
})

test('a domain spelled to pass for the workspace domain is caught', () => {
  for (const host of [
    'metroperilinsbrokers.co',
    'metroperil-insbrokers.com',
    'rnetroperilinsbrokers.com',
    'metroperilinsbroker.com',
    'metroperllinsbrokers.com',
    'metroperilinsbrokers.com.ng',
    'metroperilinsbrokers.secure-login.com',
    'metroperilinsbrokers.com.verify-account.net',
    'metrοperilinsbrokers.com',
  ]) {
    assert.equal(lookalikeOf(host, metroperil), 'metroperilinsbrokers.com', host)
  }
  assert.equal(lookalikeOf('novacraft.africa.co', novacraft), 'novacraft.africa')
  assert.equal(lookalikeOf('n0vacraft.africa', novacraft), 'novacraft.africa')
})

test('the workspace domain, its subdomains and unrelated domains are left alone', () => {
  assert.equal(lookalikeOf('metroperilinsbrokers.com', metroperil), null)
  assert.equal(lookalikeOf('mail.metroperilinsbrokers.com', metroperil), null)
  assert.equal(lookalikeOf('contact.novacraft.africa', novacraft), null)
  assert.equal(lookalikeOf('novacraft.africa', ['contact.novacraft.africa']), null, 'the parent of a workspace subdomain is the same company')
  assert.equal(lookalikeOf('mail.novacraft.africa', novacraft), null)
  for (const host of ['leadway.com', 'axamansard.com', 'gmail.com', 'google.com', 'enzyme.com', 'nairametrics.com', 'metropolitan.com']) {
    assert.equal(lookalikeOf(host, [...metroperil, 'podzyme.com']), null, host)
  }
  assert.equal(lookalikeOf('podzymes.com', ['podzyme.com']), 'podzyme.com')
  assert.equal(lookalikeOf('enzyme.com', ['podzyme.com']), null, 'sharing .com does not make two names alike')
})

test('Latin mixed with another script inside one word is caught, one script throughout is not', () => {
  assert.deepEqual(mixedScriptWord('pаypal.com'), { word: 'pаypal', script: 'Cyrillic' })
  assert.deepEqual(mixedScriptWord('Αpple Support'), { word: 'Αpple', script: 'Greek' })
  assert.deepEqual(mixedScriptWord('gooցle'), { word: 'gooցle', script: 'Armenian' })
  assert.equal(mixedScriptWord('Иван Петров'), null)
  assert.equal(mixedScriptWord('Ολυμπία'), null)
  assert.equal(mixedScriptWord('José Müller-Ọlálékan'), null, 'accents and diacritics are still Latin')
  assert.equal(mixedScriptWord('Ivan Иванов'), null, 'two scripts in separate words are fine')
  assert.equal(mixedScriptWord('中国.cn'), null)
})

test('punycode is read as the letters it encodes', () => {
  assert.equal(unicodeHost('xn--pypal-4ve.com'), 'pаypal.com')
  assert.equal(unicodeHost('xn--mnchen-3ya.de'), 'münchen.de')
  assert.equal(unicodeHost('example.com'), 'example.com')
})

test('the reasons name the domain and what it imitates', () => {
  assert.deepEqual(
    impersonationReasons({ from: 'Claims <claims@metroperllinsbrokers.com>' }, metroperil),
    ['The sender’s domain metroperllinsbrokers.com looks like your own metroperilinsbrokers.com'],
  )
  assert.deepEqual(
    impersonationReasons({ from: 'PayPal <service@xn--pypal-4ve.com>' }, metroperil),
    ['The sender’s address mixes English letters with Cyrillic letters (pаypal.com, written xn--pypal-4ve.com), a common phishing trick'],
  )
  assert.deepEqual(
    impersonationReasons({ from: '"Pаypal Support" <alerts@gmail.com>' }, metroperil),
    ['The sender’s name mixes English letters with Cyrillic letters (Pаypal), a common phishing trick'],
  )
  assert.deepEqual(
    impersonationReasons({ from: 'Broker <info@leadway.com>', replyTo: ['accounts@metroperilinsbroker.com'] }, metroperil),
    ['The reply-to domain metroperilinsbroker.com looks like your own metroperilinsbrokers.com'],
  )
  assert.deepEqual(impersonationReasons({ from: 'Ops <ops@metroperilinsbrokers.com>', replyTo: ['x@metroperilinsbroker.com'] }, metroperil), [], 'own mail is never flagged')
  assert.deepEqual(impersonationReasons({ from: 'Иван Петров <ivan@yandex.ru>' }, metroperil), [])
  assert.deepEqual(impersonationReasons({ from: 'Leadway <info@leadway.com>' }, metroperil), [])
})

test('a warning raises clean mail to suspicious but never quarantines it', () => {
  assert.deepEqual(raiseRisk('clean', [], ['x']), { risk: 'suspicious', reasons: ['x'] })
  assert.deepEqual(raiseRisk('spam', ['y'], ['x']), { risk: 'spam', reasons: ['x', 'y'] })
  assert.deepEqual(raiseRisk('suspicious', ['x'], ['x']), { risk: 'suspicious', reasons: ['x'] }, 'a stored warning is not repeated')

  const lookalike = { from: 'Billing <billing@examp1e.com>', dmarc: 'pass', spf: 'pass', dkim: 'pass', receivedAt: '2026-10-14T09:00:00.000Z' }
  const verdict = judgeMessage(lookalike, { ...stranger, replied: 3, firstSeen: '2025-01-01T00:00:00.000Z' })
  assert.equal(verdict.risk, 'suspicious', 'even a sender written back to is warned about')
  assert.equal(verdict.quarantine, false)
  assert.deepEqual(verdict.reasons, ['The sender’s domain examp1e.com looks like your own example.com'])
  assert.equal(judgeMessage(lookalike, { ...stranger, trusted: true }).risk, 'clean', 'a sender the mailbox chose to trust is not warned about again')
  assert.equal(judgeMessage({ ...lookalike, from: 'Partner <hello@leadway.com>' }, stranger).risk, 'clean')
})
