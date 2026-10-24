/**
 * Typed access to the two Drizzle internals the credits slice genuinely needs.
 *
 * Drizzle's public `DB` type exposes neither the underlying `D1Database` nor the
 * dialect's `sqlToQuery`. Two features need them:
 *
 *  1. **`d1.batch([...])`** — the only way to run a guarded UPDATE + ledger
 *     INSERT atomically on D1. Drizzle's own `db.batch()` rejects raw `sql`
 *     fragments (`query._prepare is not a function`), so the statements must be
 *     prepared by hand.
 *  2. **`sqlToQuery`** — turning a `sql` template into `{ sql, params }` so those
 *     statements can be bound to `d1.prepare()`.
 *
 * Both used to be reached with `as unknown as {...}` casts scattered across the
 * credits and billing modules, which meant a Drizzle upgrade could break them at
 * *runtime* with no type error. This module is the single, documented place that
 * couples to those internals: when Drizzle moves, exactly one file needs fixing.
 *
 * The functions are deliberately tiny and side-effect free. They throw a clear
 * error rather than returning `undefined` if the shape is missing, so a broken
 * upgrade fails loudly at the call site instead of corrupting a balance.
 */

/** Minimal structural view of the Drizzle D1 driver internals we rely on. */
interface DrizzleD1Internals {
  /** The underlying Cloudflare D1 binding (Drizzle's documented escape hatch). */
  $client: D1Database
  /** The async SQLite dialect; `sqlToQuery` compiles a `SQL` node. */
  dialect: {
    sqlToQuery: (query: unknown) => { sql: string; params: unknown[] }
  }
}

/** A statement ready for `d1.prepare(...).bind(...)`. */
export interface PreparedQuery {
  sql: string
  params: unknown[]
}

/**
 * The raw `D1Database` behind a Drizzle client.
 *
 * `$client` is Drizzle's own documented accessor for the driver handle (it is
 * part of the D1 driver's public surface, not a private field), so this is the
 * least fragile of the two accessors.
 */
export function rawD1(db: unknown): D1Database {
  const client = (db as Partial<DrizzleD1Internals>).$client
  if (!client || typeof client.prepare !== 'function') {
    throw new Error('rawD1: the Drizzle client has no $client D1Database — driver shape changed')
  }
  return client
}

/**
 * Compile a Drizzle `sql` template into `{ sql, params }` for hand-binding.
 *
 * This is the one genuinely internal dependency: `dialect.sqlToQuery` is not
 * part of Drizzle's documented API. Isolated here so an upgrade breaks in one
 * obvious place with a readable error.
 */
export function toQuery(db: unknown, statement: { getSQL(): unknown }): PreparedQuery {
  const dialect = (db as Partial<DrizzleD1Internals>).dialect
  if (!dialect || typeof dialect.sqlToQuery !== 'function') {
    throw new Error('toQuery: the Drizzle client has no dialect.sqlToQuery — driver shape changed')
  }
  const compiled = dialect.sqlToQuery(statement.getSQL())
  return { sql: compiled.sql, params: compiled.params }
}
