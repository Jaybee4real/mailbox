import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const DEFAULT_BUDGET_MB = 1024
const PRUNE_TO = 0.85

let usageBytes: number | null = null
let pruning: Promise<void> | null = null

function cacheRoot(): string | null {
  if (process.env.BODY_CACHE_DIR) return process.env.BODY_CACHE_DIR
  const url = process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL ?? ''
  if (!url.startsWith('file:')) return null
  return join(dirname(url.slice('file:'.length)), 'body-cache')
}

function budgetBytes(): number {
  const megabytes = Number(process.env.BODY_CACHE_MAX_MB)
  return (Number.isFinite(megabytes) && megabytes > 0 ? megabytes : DEFAULT_BUDGET_MB) * 1024 * 1024
}

function pathFor(root: string, key: string): string {
  const digest = createHash('sha1').update(key).digest('hex')
  return join(root, digest.slice(0, 2), `${digest}.html.gz`)
}

async function cachedFiles(root: string): Promise<Array<{ path: string; size: number; used: number }>> {
  const files: Array<{ path: string; size: number; used: number }> = []
  const shards = await readdir(root).catch(() => [] as string[])
  for (const shard of shards) {
    const names = await readdir(join(root, shard)).catch(() => [] as string[])
    for (const name of names) {
      if (!name.endsWith('.html.gz')) continue
      const path = join(root, shard, name)
      const info = await stat(path).catch(() => null)
      if (info) files.push({ path, size: info.size, used: info.mtimeMs })
    }
  }
  return files
}

async function usage(root: string): Promise<number> {
  if (usageBytes === null) usageBytes = (await cachedFiles(root)).reduce((total, file) => total + file.size, 0)
  return usageBytes
}

/** Least recently read bodies go first, until the cache is back under its budget. */
async function prune(root: string): Promise<void> {
  const files = (await cachedFiles(root)).sort((first, second) => first.used - second.used)
  let total = files.reduce((sum, file) => sum + file.size, 0)
  const target = budgetBytes() * PRUNE_TO
  for (const file of files) {
    if (total <= target) break
    await rm(file.path, { force: true })
    total -= file.size
  }
  usageBytes = total
}

export async function cachedBody(key: string): Promise<string | null> {
  const root = cacheRoot()
  if (!root) return null
  const path = pathFor(root, key)
  try {
    const html = gunzipSync(await readFile(path)).toString('utf8')
    const now = new Date()
    void utimes(path, now, now).catch(() => {})
    return html
  } catch {
    return null
  }
}

export async function isBodyCached(key: string): Promise<boolean> {
  const root = cacheRoot()
  if (!root) return false
  return stat(pathFor(root, key)).then(() => true, () => false)
}

/** True once the cache has used its budget, so a background fill knows to stop. */
export async function bodyCacheFull(): Promise<boolean> {
  const root = cacheRoot()
  if (!root) return true
  return (await usage(root)) >= budgetBytes() * PRUNE_TO
}

export async function storeBody(key: string, html: string): Promise<void> {
  const root = cacheRoot()
  if (!root) return
  const target = pathFor(root, key)
  const temporary = `${target}.${process.pid}.tmp`
  const packed = gzipSync(Buffer.from(html, 'utf8'))
  if (packed.length > budgetBytes() / 10) return
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(temporary, packed)
    await rename(temporary, target)
    usageBytes = (await usage(root)) + packed.length
    if (usageBytes > budgetBytes() && !pruning) {
      pruning = prune(root).finally(() => {
        pruning = null
      })
    }
  } catch (err) {
    console.warn('[body-cache] could not store a body', err)
  }
}

export function bodyCacheEnabled(): boolean {
  return cacheRoot() !== null
}
