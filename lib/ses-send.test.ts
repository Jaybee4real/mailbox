import assert from 'node:assert/strict'
import { sesDestination } from './ses-send.ts'

// The bug: with a blind copy present, only the blind copy was handed to SES, and SES
// delivers a raw message to its Destination alone — the real recipients were dropped.
assert.deepEqual(
  sesDestination({ to: ['rokoeman@example.com'], bcc: ['automated@example.org'] }),
  { ToAddresses: ['rokoeman@example.com'], BccAddresses: ['automated@example.org'] },
)
assert.deepEqual(
  sesDestination({ to: ['Robert <robert@example.com>'], cc: ['"Ops, Team" <ops@example.com>'] }),
  { ToAddresses: ['robert@example.com'], CcAddresses: ['ops@example.com'] },
  'display names stay in the headers; the envelope carries bare addresses',
)
assert.deepEqual(
  sesDestination({ to: ['a@example.com'], cc: ['A@example.com'], bcc: ['a@example.com', 'b@example.com'] }),
  { ToAddresses: ['a@example.com'], BccAddresses: ['b@example.com'] },
  'an address named twice is delivered once',
)
assert.deepEqual(sesDestination({ to: ['a@example.com'] }), { ToAddresses: ['a@example.com'] })
console.log('ok - ses envelope carries every recipient')
