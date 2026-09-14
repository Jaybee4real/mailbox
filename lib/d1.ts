/**
 * Cloudflare D1 over the REST API, shaped like the `neon()` tagged-template client so
 * query call sites read the same. The app runs on Vercel, so there is no Worker binding
 * available — every statement is an HTTPS round-trip to Cloudflare.
 */

type Param = string | number | null
export type D1Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>

const API = 'https://api.cloudflare.com/client/v4'

function config() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const databaseId = process.env.D1_DATABASE_ID
  const token = process.env.CLOUDFLARE_D1_TOKEN
  if (!accountId || !databaseId || !token) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and CLOUDFLARE_D1_TOKEN must be configured')
  }
  return { accountId, databaseId, token }
}

/** SQLite has no boolean or object types — normalise before binding. */
function toParam(value: unknown): Param {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export async function d1Query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const { accountId, databaseId, token } = config()
  const response = await fetch(`${API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params: params.map(toParam) }),
  })
  const payload = (await response.json()) as {
    success?: boolean
    errors?: Array<{ message?: string }>
    result?: Array<{ results?: Record<string, unknown>[]; success?: boolean; error?: string }>
  }
  if (!response.ok || !payload.success) {
    const detail = payload.errors?.map(entry => entry.message).filter(Boolean).join('; ') || `HTTP ${response.status}`
    throw new Error(`D1 query failed: ${detail}`)
  }
  const first = payload.result?.[0]
  if (first?.error) throw new Error(`D1 query failed: ${first.error}`)
  return first?.results ?? []
}

/** Tagged-template entry point: interpolations become bound `?` parameters. */
export function d1(): D1Sql {
  return (strings, ...values) => d1Query(strings.raw.join('?'), values)
}

/** Run several statements in order — used for schema setup. */
export async function d1Batch(statements: string[]): Promise<void> {
  for (const statement of statements) {
    const trimmed = statement.trim()
    if (trimmed) await d1Query(trimmed)
  }
}
