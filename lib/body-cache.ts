import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

function cacheRoot(): string | null {
  if (process.env.BODY_CACHE_DIR) return process.env.BODY_CACHE_DIR
  const url = process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL ?? ''
  if (!url.startsWith('file:')) return null
  return join(dirname(url.slice('file:'.length)), 'body-cache')
}

function pathFor(root: string, key: string): string {
  const digest = createHash('sha1').update(key).digest('hex')
  return join(root, digest.slice(0, 2), `${digest}.html.gz`)
}

export async function cachedBody(key: string): Promise<string | null> {
  const root = cacheRoot()
  if (!root) return null
  try {
    return gunzipSync(await readFile(pathFor(root, key))).toString('utf8')
  } catch {
    return null
  }
}

export async function isBodyCached(key: string): Promise<boolean> {
  const root = cacheRoot()
  if (!root) return false
  return stat(pathFor(root, key)).then(() => true, () => false)
}

export async function storeBody(key: string, html: string): Promise<void> {
  const root = cacheRoot()
  if (!root) return
  const target = pathFor(root, key)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(temporary, gzipSync(Buffer.from(html, 'utf8')))
    await rename(temporary, target)
  } catch (err) {
    console.warn('[body-cache] could not store a body', err)
  }
}

export function bodyCacheEnabled(): boolean {
  return cacheRoot() !== null
}
