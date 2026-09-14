/**
 * Copies attachment bytes out of Resend and into our bucket, for messages received
 * before the app started keeping its own copy.
 *
 * The work happens on the deployment, not here: this only drives it, so the files
 * travel between the provider and the bucket inside one region instead of down to
 * whatever connection is running the script.
 *
 * Resumable — a message is picked up only while it has no stored key, so stopping
 * and re-running costs nothing.
 *
 *   MAINTENANCE_TOKEN=… node scripts/backfill-attachments.mjs [--limit 25] [--host https://…]
 */

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const HOST = flag('host', 'https://mail.example.com')
const LIMIT = Number(flag('limit', 25))
const TOKEN = process.env.MAINTENANCE_TOKEN

if (!TOKEN) {
  console.error('MAINTENANCE_TOKEN is not set.')
  process.exit(1)
}

const readable = bytes => {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

const call = async query => {
  const response = await fetch(`${HOST}/api/mail/maintenance/attachments?${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

const started = Date.now()
let copied = 0
let files = 0
let bytes = 0
let failed = 0

const first = await call(`limit=1&count=1`)
const outstanding = first.remaining ?? 0
copied += first.copied
files += first.files
bytes += first.bytes
console.log(`  ${outstanding} message(s) still to copy\n`)

for (let round = 1; outstanding > 0 && round <= 5000; round += 1) {
  let result
  try {
    result = await call(`limit=${LIMIT}`)
  } catch (err) {
    console.log(`  round ${round}: ${err.message} — retrying in 10s`)
    await new Promise(resolve => setTimeout(resolve, 10_000))
    continue
  }

  if (result.scanned === 0) {
    console.log('\n  nothing left to copy')
    break
  }

  copied += result.copied
  files += result.files
  bytes += result.bytes
  failed += result.failed

  const elapsed = (Date.now() - started) / 1000
  const rate = copied / Math.max(elapsed, 1)
  const left = Math.max(outstanding - copied, 0)
  const eta = rate > 0 ? Math.round(left / rate) : 0
  process.stdout.write(
    `\r  ${copied}/${outstanding} messages · ${files} files · ${readable(bytes)}` +
      `${failed ? ` · ${failed} failed` : ''} · ~${Math.floor(eta / 60)}m ${eta % 60}s left    `,
  )
}

const total = Math.round((Date.now() - started) / 1000)
console.log(`\n\n  done in ${Math.floor(total / 60)}m ${total % 60}s`)
console.log(`  ${copied} messages, ${files} files, ${readable(bytes)} copied${failed ? `, ${failed} failed` : ''}`)
