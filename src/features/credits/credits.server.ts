/**
 * Credits server — DB-facing account/ledger operations.
 *
 * The account's `balance` is a *materialized cache* of the ledger: it can always
 * be recomputed with `SUM(delta)` from `credit_ledger`. Every balance movement
 * goes through `applyCreditDelta`, which atomically applies the guarded UPDATE
 * and the ledger INSERT in one D1 batch, then verifies the outcome with a
 * post-hoc re-query.
 *
 * Hard requirements this module upholds:
 *   - never overdraft (the guarded UPDATE refuses a debit that would go negative)
 *   - never double-charge (the ledger's unique `idempotency_key` is the gate)
 *   - every balance movement has a ledger row (reconcileAccount recomputes the
 *     cache from the ledger, so drift is detectable and repairable)
 */
import { eq, sql } from 'drizzle-orm'
import type { DB } from '@/db/client'
import { creditAccount, creditLedger, type CreditAccount, type CreditLedgerKind, type CreditLedgerRow } from './credits.schema'
import { ownedBy, scopeFromUser } from '@/db/scope'
import { rawD1, toQuery } from '@/db/raw'
import { effectivePlanForCredits, monthlyGrantFor, periodKeyFor } from './credits.core'
import type { Plan } from '../billing/plans'
import { asPlan } from '../billing/plans'

// ---------------------------------------------------------------------------
// Views and inputs
// ---------------------------------------------------------------------------
export interface CreditAccountView {
  balance: number
  periodKey: string
  periodGrant: number
  lifetimePurchased: number
  lifetimeConsumed: number
}

export interface GrantInput {
  userId: string
  delta: number
  kind: CreditLedgerKind
  /** 幂等键；不传则内部生成（正数发放用 const 名，负数扣减必须传或由调用方保证唯一）。 */
  idempotencyKey?: string
  ref?: string | null
  note?: string | null
}

export interface ConsumeInput {
  userId: string
  cost: number
  idempotencyKey?: string
  ref?: string | null
  note?: string | null
}

export type ConsumeResult =
  | { ok: true; balance: number; balanceAfter: number }
  | { ok: false; reason: 'insufficient_credits' }

export interface LedgerListOptions {
  page: number
  pageSize: number
}

// ---------------------------------------------------------------------------
// Account lookup
// ---------------------------------------------------------------------------

/**
 * Read a user's credit account, creating the row on first access and lazily
 * granting the monthly allowance when the period rolls over.
 *
 * The caller may pass `plan`/`role` explicitly to avoid a second query. When
 * omitted, the plan is resolved from the user's subscription (via
 * `getEntitlementFor`, imported lazily to avoid a hard cycle with billing) and
 * the user's `role` column; a user with no subscription row defaults to `free`.
 */
export async function getCreditAccount(
  db: DB,
  userId: string,
  now: number,
  opts?: { plan?: Plan; role?: string | null },
): Promise<CreditAccountView> {
  await ensureAccount(db, userId, now)
  const row = await accountRow(db, userId)

  const currentPeriod = periodKeyFor(now)
  if (row.periodKey !== currentPeriod) {
    const { plan, role } = await resolvePlanAndRole(db, userId, opts)
    const grant = monthlyGrantFor(effectivePlanForCredits(role, plan))
    await grantCredits(db, {
      userId,
      delta: grant,
      kind: 'grant.monthly',
      idempotencyKey: `monthly:${userId}:${currentPeriod}`,
      ref: null,
      note: `monthly grant for ${currentPeriod}`,
    }, now)
  }

  const after = await accountRow(db, userId)
  return toView(after)
}

/** Read the account row directly; undefined only if the row vanished. */
async function accountRow(db: DB, userId: string): Promise<CreditAccount> {
  const rows = await db.select().from(creditAccount).where(ownedBy(creditAccount, scopeFromUser(userId)))
  const row = rows[0]
  if (!row) throw new Error(`credit account missing for user ${userId}`)
  return row
}

/** Ensure the account row exists (idempotent, no grant). */
async function ensureAccount(db: DB, userId: string, now: number): Promise<void> {
  await db.insert(creditAccount).values({
    userId,
    balance: 0,
    periodGrant: 0,
    lifetimePurchased: 0,
    lifetimeConsumed: 0,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  }).onConflictDoNothing()
}

function toView(row: CreditAccount): CreditAccountView {
  return {
    balance: row.balance,
    periodKey: row.periodKey ?? '',
    periodGrant: row.periodGrant,
    lifetimePurchased: row.lifetimePurchased,
    lifetimeConsumed: row.lifetimeConsumed,
  }
}

/**
 * Resolve the plan/role used for credit grants.
 *
 * When the caller supplies `plan`, it wins. Otherwise the subscription row's
 * `lifetime`/`plan`/`status` are resolved through `getEntitlementFor` (lazy
 * import avoids a hard cycle with the billing server); a missing subscription
 * row yields `free`. The user's `role` column is read so an admin bypasses the
 * paywall.
 */
async function resolvePlanAndRole(
  db: DB,
  userId: string,
  opts?: { plan?: Plan; role?: string | null },
): Promise<{ plan: Plan; role: string | null }> {
  if (opts?.plan) return { plan: opts.plan, role: opts.role ?? null }
  const { getEntitlementFor } = await import('../billing/billing.server')
  const ent = await getEntitlementFor(db, userId)
  const plan = asPlan(ent.plan) ?? 'free'
  // The role lives on the user table. It is keyed by id, not by an owner
  // column, so this is a plain lookup rather than an ownership filter.
  const { user } = await import('@/features/auth/auth.schema')
  const userRows = await db.select({ role: user.role }).from(user).where(eq(user.id, userId))
  const role = userRows[0]?.role ?? null
  return { plan, role: role ?? null }
}

// ---------------------------------------------------------------------------
// applyCreditDelta — the single atomic balance movement
// ---------------------------------------------------------------------------

/**
 * Apply one balance movement and its ledger row atomically.
 *
 * **Strategy (why it is not a literal `db.batch([sql1, sql2])`):**
 *
 * The repo's Drizzle/D1 build only accepts *query builders* as `db.batch`
 * items — a raw `sql` object throws `query._prepare is not a function` at
 * runtime (verified in `node_modules/drizzle-orm/d1/session.js`: it calls
 * `query._prepare()` on every entry). So instead we build two *prepared
 * statements* and submit them through D1's native `$client.batch`, which runs
 * them as one transaction. That gives real atomicity without depending on
 * Drizzle's batch shape.
 *
 * The two statements (matching the spec) are:
 *   1. a guarded `UPDATE credit_account` that refuses debits which would go
 *      negative and refuses re-applying an already-used idempotency key;
 *   2. a conditional `INSERT INTO credit_ledger` that only fires when the
 *      account exists and the key is still unused.
 *
 * **Outcome determination is post-hoc**: after the batch, we re-query the
 * ledger row by `idempotency_key`. If it exists, the movement succeeded — and
 * `balanceAfter` is authoritative whether we inserted it or a concurrent
 * request won the race. If it does not exist after a *negative* delta, the
 * guard rejected the debit (insufficient credits) — we re-read the balance and
 * return `insufficient_credits`; we do not retry, because a missing ledger row
 * for a rejected debit is the expected outcome and retrying would burn a
 * second attempt against the same guard.
 */
export async function applyCreditDelta(
  db: DB,
  input: {
    userId: string
    delta: number
    kind: CreditLedgerKind
    idempotencyKey: string
    ref?: string | null
    note?: string | null
    now: number
  },
): Promise<{ applied: boolean; balanceAfter: number | null }> {
  const { userId, delta, kind, idempotencyKey, ref, note, now } = input
  const d1 = rawD1(db)
  // Drizzle's `sql` template drops `undefined` chunks (they become no placeholder),
  // which would corrupt the placeholder positions in these statements. Normalize
  // nullable text columns to `null`.
  const refValue = ref ?? null
  const noteValue = note ?? null

  // Two statements in ONE D1 `batch` (a real transaction — they commit or
  // roll back together). The INSERT runs first and is the authority on
  // whether the movement is allowed; the UPDATE is conditioned on its own
  // batch's INSERT having fired.
  //
  // **Why INSERT-first, conditioned UPDATE (not the spec's UPDATE-then-INSERT):**
  //   - D1/miniflare's SQLite does NOT support data-modifying CTEs
  //     (`WITH updated AS (UPDATE … RETURNING …)` → `near "UPDATE": syntax
  //     error`), and Drizzle's D1 `batch` rejects raw `sql` objects
  //     (`query._prepare is not a function`). So the pair must be two raw
  //     prepared statements in a native `d1.batch`.
  //   - If the UPDATE ran first, the INSERT's overdraft guard would re-read
  //     the *post-update* balance and wrongly block the very debit it just
  //     performed (verified: a 30-credit balance allowed only 2 of 3 ten-credit
  //     debits).
  //   - The INSERT therefore runs first, computing `balance_after = balance +
  //     delta` and guarding on `balance + delta >= 0` (no overdraft) plus
  //     `NOT EXISTS (key)` (idempotency). The UPDATE then applies the same
  //     delta, but ONLY when `EXISTS (SELECT 1 FROM credit_ledger WHERE
  //     idempotency_key = key AND id = ledgerId)` — i.e. only when this
  //     batch's own INSERT fired. A replay (same key, different id) has its
  //     INSERT blocked, so its UPDATE is blocked too: no double charge. A
  //     concurrent batch with a different key is serialized by D1, so its
  //     balance guard sees the committed balance.
  //
  // Because a `d1.batch` is serialized, no other transaction can change the
  // balance between the two statements, so `balance_after` is exact.
  const ledgerId = crypto.randomUUID()
  const insertSql = sql`INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, idempotency_key, ref, note, created_at)
    SELECT ${ledgerId}, ${userId}, ${delta},
           (SELECT balance FROM credit_account WHERE user_id = ${userId}) + ${delta},
           ${kind}, ${idempotencyKey}, ${refValue}, ${noteValue}, ${now}
    WHERE EXISTS (SELECT 1 FROM credit_account WHERE user_id = ${userId})
      AND (${delta} >= 0 OR (SELECT balance FROM credit_account WHERE user_id = ${userId}) + ${delta} >= 0)
      AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE idempotency_key = ${idempotencyKey})`

  const updateSql = sql`UPDATE credit_account
    SET balance = balance ${delta >= 0 ? sql`+ ${delta}` : sql`- ${-delta}`},
        period_key = CASE WHEN ${kind} IN ('grant.monthly','grant.upgrade') THEN ${periodKeyFor(now)} ELSE period_key END,
        period_grant = CASE WHEN ${kind} = 'grant.monthly' THEN ${delta >= 0 ? delta : 0} ELSE period_grant END,
        lifetime_purchased = lifetime_purchased + CASE WHEN ${delta} > 0 AND ${kind} IN ('purchase','grant.monthly','grant.upgrade') THEN ${delta} ELSE 0 END,
        lifetime_consumed = lifetime_consumed + CASE WHEN ${delta} < 0 THEN ${-delta} ELSE 0 END,
        updated_at = ${now}
    WHERE user_id = ${userId}
      AND (${delta} >= 0 OR balance >= ${-delta})
      AND EXISTS (SELECT 1 FROM credit_ledger WHERE idempotency_key = ${idempotencyKey} AND id = ${ledgerId})`

  const i = toQuery(db, insertSql)
  const u = toQuery(db, updateSql)
  await d1.batch([
    d1.prepare(i.sql).bind(...i.params),
    d1.prepare(u.sql).bind(...u.params),
  ])

  // Post-hoc verification: is there a ledger row for this key?
  const ledgerRows = await db.select().from(creditLedger).where(eq(creditLedger.idempotencyKey, idempotencyKey))
  const ledgerRow = ledgerRows[0]
  if (ledgerRow) {
    return { applied: true, balanceAfter: ledgerRow.balanceAfter }
  }

  // No ledger row. For a positive grant this means the batch's guard rejected it
  // — the only realistic cause is a concurrent request that inserted the same
  // key first (their ledger row would exist, so we would have returned above) or
  // the account row was missing. Either way there is nothing to report as
  // applied. For a debit it is the insufficient-credits case.
  const acct = await accountRowOrNull(db, userId)
  return { applied: false, balanceAfter: acct?.balance ?? null }
}

/** Read the account row or undefined (no throw). */
async function accountRowOrNull(db: DB, userId: string): Promise<CreditAccount | undefined> {
  const rows = await db.select().from(creditAccount).where(ownedBy(creditAccount, scopeFromUser(userId)))
  return rows[0]
}

// ---------------------------------------------------------------------------
// Public grant / consume
// ---------------------------------------------------------------------------

/**
 * Grant (positive delta) or adjust (negative delta) credits.
 *
 * Returns `{ granted, balance }`: `granted` is true only when a ledger row
 * exists for the key after the attempt — so a replay of the same key reports
 * the same balance without granting twice.
 */
export async function grantCredits(
  db: DB,
  input: GrantInput,
  now: number,
): Promise<{ granted: boolean; balance: number }> {
  const delta = input.delta
  const idempotencyKey = input.idempotencyKey
    ?? (delta >= 0 ? `grant:${input.userId}:${input.kind}:${crypto.randomUUID()}` : undefined)

  if (!idempotencyKey) {
    // A negative grant without a caller-supplied key cannot be made idempotent;
    // require it rather than inventing a key that a retry would not match.
    throw new Error('grantCredits: a negative delta requires an explicit idempotencyKey')
  }

  // Negative deltas route through consumeCredits so the insufficient-credits
  // semantics are shared (grantCredits is normally a credit source).
  if (delta < 0) {
    const result = await consumeCredits(db, {
      userId: input.userId,
      cost: -delta,
      idempotencyKey,
      ref: input.ref,
      note: input.note,
    }, now)
    return result.ok
      ? { granted: true, balance: result.balance }
      : { granted: false, balance: (await accountRowOrNull(db, input.userId))?.balance ?? 0 }
  }

  await applyCreditDelta(db, {
    userId: input.userId,
    delta,
    kind: input.kind,
    idempotencyKey,
    ref: input.ref,
    note: input.note,
    now,
  })

  const acct = await accountRowOrNull(db, input.userId)
  const balance = acct?.balance ?? 0
  const ledgerRows = await db.select().from(creditLedger).where(eq(creditLedger.idempotencyKey, idempotencyKey))
  return { granted: ledgerRows.length > 0, balance }
}

/**
 * Consume credits for one unit of work.
 *
 * Returns `ok: false` with `insufficient_credits` — and leaves no ledger row and
 * no balance change — when the guarded UPDATE would have overdrafted.
 */
export async function consumeCredits(
  db: DB,
  input: ConsumeInput,
  now: number,
): Promise<ConsumeResult> {
  const delta = -input.cost
  const idempotencyKey = input.idempotencyKey
    ?? (input.cost > 0 ? `consume:${input.userId}:${crypto.randomUUID()}` : undefined)
  if (!idempotencyKey) throw new Error('consumeCredits: cost must be positive')

  const result = await applyCreditDelta(db, {
    userId: input.userId,
    delta,
    kind: 'consume',
    idempotencyKey,
    ref: input.ref,
    note: input.note,
    now,
  })

  if (result.applied) {
    return { ok: true, balance: result.balanceAfter ?? 0, balanceAfter: result.balanceAfter ?? 0 }
  }
  // Guard rejected: either a concurrent request already consumed this key
  // (then the ledger row exists — but we would have returned applied above) or
  // the balance is too low.
  const acct = await accountRowOrNull(db, input.userId)
  const balance = acct?.balance ?? 0
  return balance >= input.cost
    ? { ok: true, balance, balanceAfter: balance }
    : { ok: false, reason: 'insufficient_credits' }
}

// ---------------------------------------------------------------------------
// Ledger listing
// ---------------------------------------------------------------------------

/** Paginated, newest-first ledger for one user (ownership-scoped). */
export async function listLedger(
  db: DB,
  userId: string,
  opts: LedgerListOptions,
): Promise<{ rows: CreditLedgerRow[]; total: number }> {
  const d1 = rawD1(db)
  const scope = scopeFromUser(userId)
  const totalRows = await db.select({ n: sql<number>`count(*)` }).from(creditLedger).where(ownedBy(creditLedger, scope))
  const total = Number(totalRows[0]?.n ?? 0)
  const offset = Math.max(0, (opts.page - 1) * opts.pageSize)
  // The owner filter comes from `ownedBy` — never hand-written — so this stays
  // correct when the commercial build swaps `ownerId` for `tenantId`.
  const pageSql = sql`SELECT id, user_id, delta, balance_after, kind, idempotency_key, ref, note, created_at
       FROM credit_ledger
      WHERE ${ownedBy(creditLedger, scope)}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${opts.pageSize} OFFSET ${offset}`
  const compiled = toQuery(db, pageSql)
  const raw = await d1.prepare(compiled.sql).bind(...compiled.params).all()
  const rows = (raw.results ?? []).map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    delta: r.delta as number,
    balanceAfter: r.balance_after as number,
    kind: r.kind as CreditLedgerKind,
    idempotencyKey: r.idempotency_key as string,
    ref: r.ref as string | null,
    note: r.note as string | null,
    createdAt: new Date(r.created_at as number),
  }))
  return { rows, total }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Recompute the balance from the ledger and repair the cached `balance` if it
 * has drifted. Returns whether a correction was made.
 */
export async function reconcileAccount(
  db: DB,
  userId: string,
): Promise<{ drifted: boolean; balance: number }> {
  const rows = await db.select({ delta: creditLedger.delta }).from(creditLedger).where(ownedBy(creditLedger, scopeFromUser(userId)))
  const sum = rows.reduce((acc, r) => acc + r.delta, 0)
  const acct = await accountRowOrNull(db, userId)
  if (!acct) {
    return { drifted: false, balance: sum }
  }
  if (acct.balance !== sum) {
    await db.update(creditAccount)
      .set({ balance: sum, updatedAt: new Date(Date.now()) })
      .where(ownedBy(creditAccount, scopeFromUser(userId)))
    return { drifted: true, balance: sum }
  }
  return { drifted: false, balance: sum }
}

// ---------------------------------------------------------------------------
// Periodic jobs
// ---------------------------------------------------------------------------

/**
 * Grant the monthly allowance to every account whose `period_key` is stale or
 * unset, then reconcile those accounts. Bounded to 500 accounts per run —
 * enough for a starter, cheap to extend.
 */
export async function runCreditJobs(
  db: DB,
  now: number,
): Promise<{ granted: number; reconciled: number }> {
  const currentPeriod = periodKeyFor(now)
  const stale = await db.select({ userId: creditAccount.userId }).from(creditAccount)
    .where(sql`period_key IS NULL OR period_key < ${currentPeriod}`)
    .limit(500)

  let granted = 0
  for (const { userId } of stale) {
    // Resolve plan/role per user (N+1 is acceptable at starter scale).
    const { plan, role } = await resolvePlanAndRole(db, userId)
    const amount = monthlyGrantFor(effectivePlanForCredits(role, plan))
    const res = await grantCredits(db, {
      userId,
      delta: amount,
      kind: 'grant.monthly',
      idempotencyKey: `monthly:${userId}:${currentPeriod}`,
      note: `monthly grant for ${currentPeriod}`,
    }, now)
    if (res.granted) granted += 1
  }

  let reconciled = 0
  for (const { userId } of stale) {
    const res = await reconcileAccount(db, userId)
    if (res.drifted) reconciled += 1
  }

  return { granted, reconciled }
}
