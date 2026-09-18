/**
 * Fills the dev mailbox with enough traffic to exercise the list, search, paging
 * and the large-file path. Idempotent: every row it writes is prefixed `dev-`,
 * so re-running replaces rather than accumulates.
 *
 *   node scripts/seed-dev.mjs
 */

import { createClient } from '@libsql/client'
import { randomBytes, scrypt } from 'node:crypto'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'

const scryptAsync = promisify(scrypt)

// Read .env.local the same way Next does, so this needs no extra wiring.
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
}

const db = createClient({
  url: process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL,
  authToken: process.env.DATABASE_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN,
})

const DEV_ADDRESS = 'test@example.com'
/** Written into the body of every message whose link is locked, the way a sender would. */
const SHARE_PASSWORD = 'open-sesame'
const TOTAL = 500
const WITH_ATTACHMENTS = 10

const SUBJECTS = [
  'Marine cargo cover for a Shenzhen shipment', 'Motor fleet renewal, twelve vehicles',
  'Group life for forty staff', 'Builders liability on the Ikoyi site',
  'Goods in transit, weekly runs to Aba', 'Professional indemnity renewal',
  'Fire and perils survey report', 'Fidelity guarantee bond wording',
  'Travel policy for the directors', 'Container insurance question',
  'Claim notification, warehouse flood', 'Certificate needed for Form M',
  'Premium schedule for review', 'Query on the excess clause',
  'Renewal terms, please confirm', 'Adding a driver to the fleet policy',
  'Endorsement request', 'Cover note for tomorrow',
  'Broker appointment letter', 'Annual review meeting',
]

const COMPANIES = [
  'Lagos Freight', 'Zenith Logistics', 'Tabernacle Group', 'BuildRight', 'Harbour Traders',
  'Ikeja Motors', 'Delta Shipping', 'Crown Estates', 'Nova Foods', 'Apex Manufacturing',
  'Sable Energy', 'Riverside Farms', 'Onyx Retail', 'Pioneer Textiles', 'Summit Health',
]

const BODIES = [
  'Please find the details below. Let me know if you need anything further before we proceed.',
  'Following up on our call this morning. The figures we discussed are attached for your records.',
  'We would like to confirm the terms before the renewal date. Could you send the schedule?',
  'There has been a change to the risk since the last renewal. Details follow.',
  'Our bank is asking for the certificate before they will release the shipment.',
  'Could you clarify what the excess would be on a claim of this size?',
  'We are adding two vehicles to the fleet from the first of next month.',
  'The survey has been completed. The report raises two points we should discuss.',
]

const pick = (list, index) => list[index % list.length]

/** A deterministic sequence, so a re-run produces the same mailbox. */
function seededRandom(seed) {
  let value = seed
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296
    return value / 4294967296
  }
}

/** The shape lib/password.ts verifies. A bare digest is not it, and never matched. */
async function hashPassword(plain) {
  const salt = randomBytes(16)
  const key = await scryptAsync(plain, salt, 64, { N: 16384 })
  return `scrypt$16384$${salt.toString('hex')}$${key.toString('hex')}`
}

async function ensureDevAccount() {
  const hash = await hashPassword(DEV_ADDRESS)
  await db.execute({
    sql: `INSERT INTO mail_accounts (email, role, name, address, status, created_at, password_hash, password_is_default)
          VALUES (?, 'member', 'Dev Test', ?, 'active', ?, ?, 1)
          ON CONFLICT (email) DO UPDATE SET status = 'active', address = excluded.address`,
    args: [DEV_ADDRESS, DEV_ADDRESS, new Date().toISOString(), hash],
  })
  return hash
}

async function main() {
  await ensureDevAccount()
  console.log(`  account ready: ${DEV_ADDRESS}`)

  await db.execute("DELETE FROM mail_inbox WHERE id LIKE 'dev-%'")
  await db.execute("DELETE FROM mail_shares WHERE id LIKE 'devshare%'")

  const random = seededRandom(20260904)
  const now = Date.now()

  // Real files, uploaded once and then shared by every message that claims to carry one,
  // so opening an attachment in the seeded mailbox opens something. Without a bucket
  // configured the records are written on their own, as they always were.
  const { buildSamples, buildHeavySamples } = await import('./sample-files.mjs')
  const bucketReady = Boolean((process.env.S3_BUCKET ?? process.env.R2_BUCKET) && (process.env.S3_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID) && (process.env.S3_ENDPOINT ?? process.env.R2_S3_ENDPOINT))
  let smallFiles = []
  let heavyFiles = []
  if (bucketReady) {
    const { putObject } = await import('../lib/r2.ts')
    for (const sample of buildSamples()) {
      const key = `dev/samples/${sample.filename}`
      const stored = await putObject(key, sample.bytes, sample.contentType)
      if (stored) smallFiles.push([sample.filename, sample.bytes.length, sample.contentType, key])
    }
    console.log(`  ${smallFiles.length} sample files uploaded, and shared by the messages that carry one`)

    for (const sample of buildHeavySamples()) {
      const key = `shares/dev/${sample.filename}`
      const stored = await putObject(key, sample.bytes, sample.contentType)
      if (stored) heavyFiles.push([sample.filename, sample.bytes.length, sample.contentType, key])
    }
    const heavyBytes = heavyFiles.reduce((total, file) => total + file[1], 0)
    console.log(`  ${heavyFiles.length} linked files uploaded, ${(heavyBytes / 1e6).toFixed(0)} MB in all`)
  }
  // Without a bucket the share records still exist so the link page renders; the download
  // is what cannot work, and the route already says so rather than failing obscurely.
  if (!heavyFiles.length) {
    console.log('  no bucket configured: linked files are recorded but hold no bytes')
    heavyFiles = [
      ['site-survey-photos.zip', 1_850_000_000, 'application/zip', 'shares/dev/site-survey-photos.zip'],
      ['warehouse-walkthrough.mp4', 1_240_000_000, 'video/mp4', 'shares/dev/warehouse-walkthrough.mp4'],
      ['fleet-inspection-4k.mov', 980_000_000, 'video/quicktime', 'shares/dev/fleet-inspection-4k.mov'],
      ['claims-archive-2019-2025.zip', 740_000_000, 'application/zip', 'shares/dev/claims-archive-2019-2025.zip'],
      ['policy-scans-full.pdf', 512_000_000, 'application/pdf', 'shares/dev/policy-scans-full.pdf'],
      ['drone-footage-ikoyi.mp4', 430_000_000, 'video/mp4', 'shares/dev/drone-footage-ikoyi.mp4'],
      ['premium-model.xlsx', 96_000_000, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'shares/dev/premium-model.xlsx'],
      ['risk-register.csv', 62_000_000, 'text/csv', 'shares/dev/risk-register.csv'],
      ['broker-pack.pdf', 48_000_000, 'application/pdf', 'shares/dev/broker-pack.pdf'],
      ['loss-runs.zip', 31_000_000, 'application/zip', 'shares/dev/loss-runs.zip'],
    ]
  }
  if (!smallFiles.length) {
    console.log('  no bucket configured: attachments are recorded but hold no bytes')
    smallFiles = [
      ['schedule.pdf', 240_000, 'application/pdf'],
      ['certificate.pdf', 180_000, 'application/pdf'],
      ['invoice.pdf', 96_000, 'application/pdf'],
      ['endorsement.docx', 54_000, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['vehicle-list.csv', 128_000, 'text/csv'],
      ['photo-front.jpg', 320_000, 'image/jpeg'],
      ['photo-rear.jpg', 298_000, 'image/jpeg'],
      ['claim-form.pdf', 145_000, 'application/pdf'],
      ['valuation.pdf', 210_000, 'application/pdf'],
      ['cover-note.pdf', 88_000, 'application/pdf'],
    ]
  }

  const rows = []
  const shares = []

  for (let index = 0; index < TOTAL; index += 1) {
    const id = `dev-${String(index).padStart(4, '0')}`
    const company = pick(COMPANIES, index)
    const slug = company.toLowerCase().replace(/[^a-z]+/g, '')
    // Every message comes from a different yopmail address.
    const from = `${slug}${index}@yopmail.com`
    const subject = pick(SUBJECTS, index)
    const body = pick(BODIES, index)
    const receivedAt = new Date(now - index * (1000 * 60 * 37)).toISOString()

    let attachments = []
    // Every other heavy file is locked, so both the open and the protected path can be
    // walked. A real sender tells the recipient the password, so these do too.
    let passwordNote = ''
    if (index < heavyFiles.length) {
      const [filename, size, contentType, objectKey] = heavyFiles[index]
      const shareId = `devshare${String(index).padStart(2, '0')}`
      const locked = index % 4 === 0
      shares.push([shareId, objectKey, filename, contentType, size, locked])
      attachments = [{ filename, contentType, size, shareId }]
      passwordNote = locked
        ? `\n\nThe file is behind a link rather than attached. The password is "${SHARE_PASSWORD}".`
        : '\n\nThe file is behind a link rather than attached. No password is needed.'
    } else if (index < heavyFiles.length + WITH_ATTACHMENTS) {
      const [filename, size, contentType, key] = smallFiles[(index - heavyFiles.length) % smallFiles.length]
      attachments = [key ? { filename, contentType, size, key } : { filename, contentType, size }]
    }

    // Deliberately past the first screenful: a folder whose mail all sits below the rows
    // the client happens to hold is exactly the case that used to render an endless
    // skeleton, and there is no way to notice it again if the seed never produces one.
    const trashed = index >= 420 && index % 11 === 0 ? 1 : 0
    const archived = !trashed && index >= 380 && index % 7 === 0 ? 1 : 0

    rows.push([
      id, from, JSON.stringify([DEV_ADDRESS]), '[]', '[]', '[]',
      `${subject} — ${company}`, '',
      `${body}${passwordNote}\n\nRegards,\n${company}`,
      '{}', receivedAt, random() > 0.55 ? 1 : 0,
      JSON.stringify(attachments),
      random() > 0.9 ? 1 : 0, archived, trashed, '[]', DEV_ADDRESS,
    ])
  }

  for (const [id, key, filename, contentType, size, locked] of shares) {
    await db.execute({
      sql: `INSERT OR REPLACE INTO mail_shares
            (id, object_key, filename, content_type, size, password_hash, owner, created_at, expires_at, max_downloads)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, key, filename, contentType, size,
        locked ? await hashPassword(SHARE_PASSWORD) : null,
        DEV_ADDRESS, new Date().toISOString(),
        new Date(now + 30 * 86400_000).toISOString(), null,
      ],
    })
  }
  const locked = shares.filter(share => share[5]).length
  console.log(`  ${shares.length} share records, ${locked} of them locked with "${SHARE_PASSWORD}", which their messages say`)

  // Batched: 500 individual round trips to Turso would take minutes.
  const CHUNK = 50
  for (let start = 0; start < rows.length; start += CHUNK) {
    await db.batch(
      rows.slice(start, start + CHUNK).map(args => ({
        sql: `INSERT OR REPLACE INTO mail_inbox
              (id, from_addr, to_addrs, cc, bcc, reply_to, subject, html, body_text, headers,
               received_at, read, attachments, starred, archived, trashed, labels, owner)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args,
      })),
      'write',
    )
    process.stdout.write(`\r  seeding ${Math.min(start + CHUNK, rows.length)}/${rows.length}`)
  }

  const total = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM mail_inbox WHERE owner = ?',
    args: [DEV_ADDRESS],
  })
  const withAttachments = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM mail_inbox WHERE owner = ? AND attachments != '[]'`,
    args: [DEV_ADDRESS],
  })
  const indexed = await db.execute('SELECT COUNT(*) AS n FROM mail_inbox_fts')

  console.log(`\n  ${total.rows[0].n} messages for ${DEV_ADDRESS}`)
  console.log(`  ${withAttachments.rows[0].n} carry attachments (${shares.length} behind links, ${WITH_ATTACHMENTS} ordinary)`)
  const folders = await db.execute({
    sql: `SELECT SUM(archived = 1 AND trashed = 0) AS archived, SUM(trashed = 1) AS trashed, SUM(starred = 1 AND trashed = 0) AS starred
          FROM mail_inbox WHERE lower(owner) = ?`,
    args: [DEV_ADDRESS],
  })
  const folderRow = folders.rows[0]
  console.log(`  folders: ${folderRow.archived} archived, ${folderRow.trashed} in the bin, ${folderRow.starred} starred`)

  // Two conversations put aside: one that is still waiting, and one whose time has come
  // round, so both sides of "it comes back on its own" are visible without waiting a day.
  const wakesLater = new Date(now + 36 * 3600_000).toISOString()
  const wokeAlready = new Date(now - 2 * 3600_000).toISOString()
  await db.execute({
    sql: `UPDATE mail_inbox SET snoozed_until = ?
          WHERE owner = ? AND id IN ('dev-0040', 'dev-0041', 'dev-0042')`,
    args: [wakesLater, DEV_ADDRESS],
  })
  await db.execute({
    sql: `UPDATE mail_inbox SET snoozed_until = ? WHERE owner = ? AND id = 'dev-0050'`,
    args: [wokeAlready, DEV_ADDRESS],
  })
  const napping = await db.execute({
    sql: `SELECT SUM(snoozed_until > ?) AS waiting, SUM(snoozed_until <= ?) AS woken
          FROM mail_inbox WHERE owner = ? AND snoozed_until IS NOT NULL`,
    args: [new Date(now).toISOString(), new Date(now).toISOString(), DEV_ADDRESS],
  })
  console.log(`  snoozed: ${napping.rows[0].waiting} still waiting, ${napping.rows[0].woken} already back`)
  console.log(`  search index rows: ${indexed.rows[0].n}`)
}

main().catch(err => {
  console.error('  seed failed:', err.message)
  process.exit(1)
})
