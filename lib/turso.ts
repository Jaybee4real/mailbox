/**
 * Turso (libSQL) over HTTP, exposing the same tagged-template shape the D1 client used
 * so every call site in `mailbox.ts` reads unchanged. libSQL is SQLite, so the schema
 * and its `ON CONFLICT` clauses port without translation.
 *
 * HTTP mode rather than WebSocket: Vercel functions are short-lived and a socket per
 * invocation is churn we would only pay for.
 */

import { createClient, type Client, type InValue } from '@libsql/client'

export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>

let cached: Client | null = null

function client(): Client {
  if (cached) return cached
  const url = process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL
  const authToken = process.env.DATABASE_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN
  if (!url) throw new Error('DATABASE_URL must be configured')
  // Embedded replicas and file: URLs need no token; a remote libsql:// URL does.
  cached = createClient({ url, ...(authToken ? { authToken } : {}) })
  return cached
}

/** SQLite has no boolean or object types — normalise before binding. */
function toParam(value: unknown): InValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number' || typeof value === 'bigint') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export async function tursoQuery(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const result = await client().execute({ sql, args: params.map(toParam) })
  return result.rows as unknown as Record<string, unknown>[]
}

/** Tagged-template entry point: interpolations become bound `?` parameters. */
export function turso(): SqlTag {
  return (strings, ...values) => tursoQuery(strings.raw.join('?'), values)
}

/**
 * Run several statements as one transaction. The D1 client could only loop, so a
 * half-applied schema was possible; libSQL gives us the real thing.
 */
export async function tursoBatch(statements: string[]): Promise<void> {
  await client().batch(statements.map(sql => ({ sql, args: [] })), 'write')
}
