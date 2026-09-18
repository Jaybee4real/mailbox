/**
 * Records the Content-ID of each stored file, which is what tells an embedded
 * signature image apart from something the sender actually attached.
 *
 * Metadata only — the bytes are already in the bucket, so this moves nothing and
 * costs one provider call per message.
 *
 *   node scripts/backfill-content-ids.mjs [--batch 40]
 */

import { createClient } from '@libsql/client'
import { readFileSync } from 'node:fs'

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
}

const args = process.argv.slice(2)
const at = args.indexOf('--batch')
const BATCH = at === -1 ? 40 : Number(args[at + 1])

const db = createClient({ url: process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL, authToken: process.env.DATABASE_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN })
const apiKey = process.env.RESEND_API_KEY

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

const PENDING = `FROM mail_inbox
  WHERE id NOT LIKE 'mbox-%'
    AND attachments LIKE '%"key"%'
    AND attachments NOT LIKE '%contentId%'`

const remaining = Number(
  Object.values((await retry(() => db.execute(`SELECT COUNT(*) ${PENDING}`))).rows[0])[0],
)
console.log(`  ${remaining.toLocaleString()} message(s) to annotate\n`)

let done = 0
let embedded = 0
const started = Date.now()

for (let round = 1; round <= 5000; round += 1) {
  const rows = (await retry(() => db.execute(`SELECT id, attachments ${PENDING} LIMIT ${BATCH}`))).rows
  if (rows.length === 0) break

  const updates = []
  await Promise.all(
    rows.map(async row => {
      const id = String(row.id)
      let stored = []
      try {
        stored = JSON.parse(String(row.attachments))
      } catch {
        return
      }

      const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}/attachments`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }).catch(() => null)

      // Mark it either way: a message the provider no longer holds must not be
      // re-selected forever, so it is annotated with what we already know.
      const listed = response?.ok ? ((await response.json()).data ?? []) : []
      const merged = stored.map((file, index) => {
        const match = listed[index] ?? listed.find(entry => String(entry.filename ?? '') === String(file.filename ?? ''))
        const raw = match?.content_id ? String(match.content_id).replace(/^<|>$/g, '') : ''
        if (raw && String(file.contentType ?? '').toLowerCase().startsWith('image/')) embedded += 1
        return { ...file, contentId: raw || null }
      })

      updates.push({ id, json: JSON.stringify(merged) })
    }),
  )

  for (const update of updates) {
    await retry(() =>
      db.execute({
        sql: 'UPDATE mail_inbox SET attachments = ?, attach_meta = ? WHERE id = ?',
        args: [update.json, update.json, update.id],
      }),
    )
  }
  done += updates.length
  if (updates.length === 0) break

  const rate = done / Math.max((Date.now() - started) / 1000, 1)
  process.stdout.write(
    `\r  ${done}/${remaining} messages · ${embedded} embedded images found · ${rate.toFixed(1)}/s    `,
  )
}

console.log(`\n\n  annotated ${done} message(s); ${embedded} embedded image(s) will now be hidden`)
