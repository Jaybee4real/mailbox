/**
 * Fills the columns the message list reads, so it stops falling back to the message
 * body. The fallback reads body_text, which sits behind the html blob in the record,
 * and that is the difference between a list query of ~200ms and one of ~2s.
 *
 * Newest first: those are the rows every mailbox opens on, so the first few thousand
 * buy nearly all of the benefit long before the archive is done.
 *
 * Resumable — a row is picked up only while snippet is NULL.
 *
 *   node scripts/backfill-list-columns.mjs [--batch 500]
 */

import { createClient } from '@libsql/client'
import { readFileSync } from 'node:fs'

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
}

const args = process.argv.slice(2)
const at = args.indexOf('--batch')
const BATCH = at === -1 ? 500 : Number(args[at + 1])

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

const UPDATE = `UPDATE mail_inbox SET
   snippet = substr(COALESCE(body_text, ''), 1, 320),
   thread_meta = json_object(
     'message-id', COALESCE(json_extract(headers, '$."message-id"'), ''),
     'in-reply-to', COALESCE(json_extract(headers, '$."in-reply-to"'), ''),
     'references', COALESCE(json_extract(headers, '$."references"'), '')),
   attach_meta = COALESCE(
     (SELECT json_group_array(json_object('filename', json_extract(value, '$.filename'),
                                          'contentType', json_extract(value, '$.contentType'),
                                          'size', json_extract(value, '$.size')))
      FROM json_each(CASE WHEN json_valid(attachments) THEN attachments ELSE '[]' END)),
     '[]')
 WHERE id IN (SELECT id FROM mail_inbox WHERE snippet IS NULL ORDER BY received_at DESC LIMIT ${BATCH})`

/** Turso drops a connection now and then; a dropped batch is safe to repeat. */
async function run(sql) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.execute(sql)
    } catch (err) {
      if (attempt >= 5) throw err
      await new Promise(resolve => setTimeout(resolve, 3000 * attempt))
    }
  }
}

const outstanding = Number(Object.values((await run('SELECT COUNT(*) FROM mail_inbox WHERE snippet IS NULL')).rows[0])[0])
console.log(`  ${outstanding.toLocaleString()} rows to fill, ${BATCH} at a time\n`)

const started = Date.now()
let done = 0

while (done < outstanding) {
  const result = await run(UPDATE)
  if (!result.rowsAffected) break
  done += result.rowsAffected

  const elapsed = (Date.now() - started) / 1000
  const rate = done / Math.max(elapsed, 1)
  const eta = rate > 0 ? Math.round((outstanding - done) / rate) : 0
  process.stdout.write(
    `\r  ${done.toLocaleString()}/${outstanding.toLocaleString()} · ${rate.toFixed(0)}/s · ` +
      `~${Math.floor(eta / 60)}m ${eta % 60}s left    `,
  )
}

const total = Math.round((Date.now() - started) / 1000)
const left = Number(Object.values((await run('SELECT COUNT(*) FROM mail_inbox WHERE snippet IS NULL')).rows[0])[0])
console.log(`\n\n  filled ${done.toLocaleString()} rows in ${Math.floor(total / 60)}m ${total % 60}s`)
console.log(`  still NULL: ${left.toLocaleString()}`)
