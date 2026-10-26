import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  androidOrigin, cleanName, completeRegistration, completeSignin, listPasskeys, registrationOptions, relyingParty,
  removeAllPasskeys, removePasskey, signinOptions, userHandle,
} from './passkeys'

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url')

function cbor(value: unknown): Buffer {
  const head = (major: number, length: number) => length < 24 ? Buffer.from([(major << 5) | length])
    : length < 256 ? Buffer.from([(major << 5) | 24, length]) : Buffer.from([(major << 5) | 25, length >> 8, length & 255])
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)])
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)])
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object)
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)])])
}

class Authenticator {
  readonly id = randomBytes(16)
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  private counter = 0

  constructor(private readonly origin: string, private readonly rpId: string) {}

  private authData(flags: number, attested?: Buffer) {
    const count = Buffer.alloc(4)
    count.writeUInt32BE(this.counter++)
    return Buffer.concat([createHash('sha256').update(this.rpId).digest(), Buffer.from([flags]), count, ...(attested ? [attested] : [])])
  }

  register(challenge: string) {
    const jwk = (this.keys.publicKey as KeyObject).export({ format: 'jwk' })
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]))
    const length = Buffer.from([this.id.length >> 8, this.id.length & 255])
    const authData = this.authData(0x45, Buffer.concat([Buffer.alloc(16), length, this.id, cose]))
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: this.origin }))
    return {
      id: b64url(this.id), rawId: b64url(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(cbor({ fmt: 'none', attStmt: {}, authData })), transports: ['internal'] },
    }
  }

  assert(challenge: string, email: string) {
    const authData = this.authData(0x05)
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: this.origin }))
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), this.keys.privateKey)
    return {
      id: b64url(this.id), rawId: b64url(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(signature), userHandle: b64url(userHandle(email)) },
    }
  }
}

test('the relying party is the mailbox host, and only release-signed Android builds are trusted', () => {
  const rp = relyingParty('https://mail.metroperilinsbrokers.com', ['AC:EF:96:D7:AD:40:9A:9C:37:9C:A9:DA:93:C4:81:82:BA:DE:26:78:6E:D5:9D:B9:BB:78:2B:6F:78:BD:47:B8'])
  assert.equal(rp.id, 'mail.metroperilinsbrokers.com')
  assert.deepEqual(rp.origins, ['https://mail.metroperilinsbrokers.com', 'android:apk-key-hash:rO-W161Ampw3nKnak8SBgrreJnhu1Z25u3grb3i9R7g'])
  assert.equal(androidOrigin('00:'.repeat(31) + '00'), `android:apk-key-hash:${b64url(Buffer.alloc(32))}`)
  assert.deepEqual(userHandle('Ada@Example.com'), userHandle('ada@example.com'))
  assert.equal(cleanName('  iPhone\u0000 15 '), 'iPhone 15')
})

test('a passkey registers with the account password flow and signs that account in, once per challenge', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vela-passkey-test-'))
  process.env.DATABASE_URL = `file:${directory}/test.sqlite`
  try {
    const rp = relyingParty()
    const phone = new Authenticator(rp.origins[0], rp.id)
    const ada = { email: 'ada@example.com', address: 'ada@example.com', name: 'Ada' }

    const created = await registrationOptions(ada)
    assert.ok(created)
    assert.equal(created.options.rp.id, rp.id)
    assert.equal(created.options.authenticatorSelection?.residentKey, 'required')
    assert.equal(await completeRegistration('grace@example.com', created.challenge, phone.register(created.options.challenge), 'x'), null,
      "another account cannot finish Ada's registration")

    const again = await registrationOptions(ada)
    const passkey = await completeRegistration(ada.email, again!.challenge, phone.register(again!.options.challenge), 'Ada’s iPhone')
    assert.equal(passkey?.name, 'Ada’s iPhone')
    assert.equal((await listPasskeys(ada.email)).length, 1)
    assert.equal(await completeRegistration(ada.email, again!.challenge, phone.register(again!.options.challenge), 'replay'), null,
      'a registration challenge works once')

    const signin = await signinOptions()
    assert.equal(signin.options.rpId, rp.id)
    assert.deepEqual(signin.options.allowCredentials, [], 'sign-in options never reveal which accounts have passkeys')
    assert.equal(await completeSignin(signin.challenge, phone.assert(signin.options.challenge, ada.email)), ada.email)
    assert.equal(await completeSignin(signin.challenge, phone.assert(signin.options.challenge, ada.email)), null, 'a sign-in challenge works once')

    const phishing = new Authenticator('https://mail.example.com.evil.test', rp.id)
    const evilReg = await registrationOptions(ada)
    assert.equal(await completeRegistration(ada.email, evilReg!.challenge, phishing.register(evilReg!.options.challenge), 'evil'), null,
      'a response from another origin is refused')

    const second = await signinOptions()
    assert.equal(await completeSignin(second.challenge, phone.assert(second.options.challenge, 'grace@example.com')), null,
      'a passkey cannot claim to be another account')

    const [stored] = await listPasskeys(ada.email)
    assert.ok(stored.lastUsedAt)
    assert.equal(await removePasskey('grace@example.com', stored.id), false)
    assert.equal(await removePasskey(ada.email, stored.id), true)
    const third = await signinOptions()
    assert.equal(await completeSignin(third.challenge, phone.assert(third.options.challenge, ada.email)), null, 'a removed passkey stops working')

    const fourth = await registrationOptions(ada)
    await completeRegistration(ada.email, fourth!.challenge, new Authenticator(rp.origins[0], rp.id).register(fourth!.options.challenge), 'Mac')
    await removeAllPasskeys(ada.email)
    assert.equal((await listPasskeys(ada.email)).length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
