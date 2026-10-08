import assert from 'node:assert/strict'
import test from 'node:test'
import { activeProvider, providerConfigProblem } from './mail-provider.ts'

test('a deployment that chose SES is not refused for missing a Resend key', () => {
  process.env.MAIL_PROVIDER = 'ses'
  process.env.SES_ACCESS_KEY_ID = 'AKIAEXAMPLE'
  process.env.SES_SECRET_ACCESS_KEY = 'secret'
  delete process.env.RESEND_API_KEY
  assert.equal(activeProvider(), 'ses')
  assert.equal(providerConfigProblem(), null)
})

test('each provider reports its own missing configuration', () => {
  process.env.MAIL_PROVIDER = 'ses'
  delete process.env.SES_ACCESS_KEY_ID
  delete process.env.SES_SECRET_ACCESS_KEY
  assert.match(providerConfigProblem() ?? '', /SES_ACCESS_KEY_ID/)

  process.env.MAIL_PROVIDER = 'resend'
  delete process.env.RESEND_API_KEY
  assert.match(providerConfigProblem() ?? '', /RESEND_API_KEY/)
})

test('the SES message carries every attachment, byte for byte', async () => {
  const { rawMimeFor } = await import('./mail-provider.ts')
  const pdf = Buffer.from('%PDF-1.4 a small but real-looking file '.repeat(40))
  const photo = Buffer.from(Array.from({ length: 3000 }, (_, index) => index % 256))
  const raw = rawMimeFor({
    from: 'info@example.com',
    to: ['client@example.org'],
    subject: 'Renewal',
    html: '<p>Attached.</p>',
    text: 'Attached.',
    attachments: [
      { filename: 'Renewal note.pdf', content: pdf.toString('base64') },
      { filename: 'Pièce jointe.jpeg', content: photo.toString('base64') },
    ],
  })
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="(nc_[0-9a-f]+)"/)
  assert.match(raw, /Content-Type: application\/pdf; name="Renewal note.pdf"/)
  assert.match(raw, /Content-Disposition: attachment; filename="Renewal note.pdf"/)
  assert.match(raw, /filename\*=UTF-8''Pi%C3%A8ce%20jointe\.jpeg/)
  assert.ok(raw.split('\r\n').every(line => line.length <= 998), 'no line longer than the mail limit')
  const parts = raw.split(/--nc_[0-9a-f]+/)
  const decoded = (name: string) => {
    const part = parts.find(chunk => chunk.includes(`filename="${name}"`))!
    return Buffer.from(part.split('\r\n\r\n').slice(1).join('').replace(/\s+/g, ''), 'base64')
  }
  assert.deepEqual(decoded('Renewal note.pdf'), pdf)
  assert.deepEqual(decoded('Pi_ce jointe.jpeg'), photo)
  assert.doesNotMatch(rawMimeFor({ from: 'a@b.c', to: ['d@e.f'], subject: 's', text: 't' }), /multipart\/mixed/)
})
