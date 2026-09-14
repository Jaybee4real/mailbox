/**
 * Moves message bodies out of the database and into the bucket, leaving the key
 * behind in the message headers. The reader already falls back to the bucket when a
 * row has no html of its own, so nothing needs to change for this to take effect.
 *
 * Bytes are written first and the column is cleared only once the bucket has them,
 * so an interrupted run loses nothing. Resumable — a row is picked up only while it
 * still holds html.
 *
 *   node --experimental-strip-types scripts/offload-bodies.mjs [--batch 40]
 */

import { createClient } from '@libsql/client'
import { readFileSync } from 'node:fs'
import { presign } from '../lib/r2.ts'

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
}

const args = process.argv.slice(2)
const at = args.indexOf('--batch')
const BATCH = at === -1 ? 40 : Number(args[at + 1])

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

/** Ids are ours, but these go into string-interpolated SQL: anything unexpected is left alone. */
const safeId = value => /^[A-Za-z0-9._:+@-]{1,200}$/.test(value)

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

async function retry(work) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work()
    } catch (err) {
      if (attempt >= 5) throw err
      await new Promise(resolve => setTimeout(resolve, 3000 * attempt))
    }
  }
}

const remaining = Number(
  Object.values(
    (await retry(() => db.execute("SELECT COUNT(*) FROM mail_inbox WHERE html IS NOT NULL AND html != ''"))).rows[0],
  )[0],
)
console.log(`${new Date().toISOString()}  ${remaining.toLocaleString()} bodies to move, ${BATCH} at a time`)

const started = Date.now()
let moved = 0
let deduped = 0
let failed = 0
let bytes = 0

for (let round = 1; round <= 10000; round += 1) {
  const rows = (
    await retry(() =>
      db.execute(`SELECT id, html, headers FROM mail_inbox WHERE html IS NOT NULL AND html != '' LIMIT ${BATCH}`),
    )
  ).rows

  if (rows.length === 0) break

  const statements = []
  await Promise.all(
    rows.map(async row => {
      const id = String(row.id)
      const html = String(row.html ?? '')
      if (!safeId(id)) return

      let headers = {}
      try {
        headers = JSON.parse(String(row.headers ?? '{}')) ?? {}
      } catch {
        headers = {}
      }

      // A shared copy points at the original, which already holds the body.
      if (typeof headers['shared-copy-of'] === 'string' && headers['shared-copy-of']) {
        statements.push(`UPDATE mail_inbox SET html = NULL WHERE id = '${id}'`)
        deduped += 1
        bytes += html.length
        return
      }

      const key = `bodies/${id}.html`
      try {
        const response = await fetch(presign(key, 'PUT', 300), {
          method: 'PUT',
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: html,
        })
        if (!response.ok) {
          failed += 1
          return
        }
      } catch {
        failed += 1
        return
      }

      statements.push(
        `UPDATE mail_inbox SET html = NULL, headers = json_set(COALESCE(headers, '{}'), '$."html-key"', '${key}') WHERE id = '${id}'`,
      )
      moved += 1
      bytes += html.length
    }),
  )

  if (statements.length) await retry(() => db.batch(statements, 'write'))

  // Every row failed to upload: the bucket is unreachable, and looping would spin forever.
  if (statements.length === 0) {
    console.log(`\n${new Date().toISOString()}  stopping: nothing in this batch could be written to the bucket`)
    break
  }

  if (round % 10 === 0) {
    const elapsed = (Date.now() - started) / 1000
    const rate = (moved + deduped) / Math.max(elapsed, 1)
    const left = Math.max(remaining - moved - deduped, 0)
    const eta = rate > 0 ? Math.round(left / rate) : 0
    console.log(
      `${new Date().toISOString()}  ${(moved + deduped).toLocaleString()}/${remaining.toLocaleString()} · ` +
        `${readable(bytes)} freed · ${rate.toFixed(1)}/s · ~${Math.floor(eta / 60)}m left`,
    )
  }
}

const total = Math.round((Date.now() - started) / 1000)
const left = Number(
  Object.values(
    (await retry(() => db.execute("SELECT COUNT(*) FROM mail_inbox WHERE html IS NOT NULL AND html != ''"))).rows[0],
  )[0],
)
console.log(`\n${new Date().toISOString()}  finished in ${Math.floor(total / 60)}m ${total % 60}s`)
console.log(`  moved ${moved.toLocaleString()}, deduped ${deduped.toLocaleString()}, failed ${failed.toLocaleString()}`)
console.log(`  ${readable(bytes)} taken out of the database, ${left.toLocaleString()} bodies still inline`)
