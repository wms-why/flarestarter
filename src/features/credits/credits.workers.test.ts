/**
 * Credits workers integration tests — real Cloudflare D1 (miniflare).
 *
 * Test intents:
 *  1. getCreditAccount lazy-grants once (sequential + parallel)
 *  2. consumeCredits success updates balance + ledger (balanceAfter correct)
 *  3. insufficient_credits → no ledger row, balance unchanged
 *  4. concurrent consumes never overdraft (3 succeed of 10 at cost 10, balance 30)
 *  5. idempotency replay → one ledger row, same balanceAfter
 *  6. cross-month rollover → new grant, periodKey updated, old grant not duplicated
 *  7. ownership: listLedger is scoped to the user
 *  8. grantCredits upgrade delta is applied once
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { createDb } from '@/db/client'
import { creditAccount, creditLedger } from './credits.schema'
import {
  getCreditAccount,
  grantCredits,
  consumeCredits,
  consumeIdempotencyKey,
  listLedger,
  reconcileAccount,
} from './credits.server'
import { applyCreditsSchema, seedUser, seedCreditUser } from './test-helpers'

beforeAll(async () => {
  await applyCreditsSchema(env.DB)
})

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Fixed epoch values for deterministic period boundaries. */
const OCTOBER = Date.UTC(2026, 9, 15, 0, 0, 0, 0) // 2026-10-15
const NOVEMBER = Date.UTC(2026, 10, 15, 0, 0, 0, 0) // 2026-11-15

// ---------------------------------------------------------------------------
// 1. getCreditAccount lazy-grants once
// ---------------------------------------------------------------------------
describe('1. getCreditAccount lazy-grants the monthly allowance exactly once', () => {
  test('sequential calls grant once; parallel calls grant once', async () => {
    const db = createDb(env.DB)
    const userId = `lazy-${crypto.randomUUID()}`
    await seedUser(db, userId)

    // Two sequential calls — the second must not grant again.
    const a = await getCreditAccount(db, userId, OCTOBER)
    expect(a.balance).toBe(100) // free tier
    expect(a.periodKey).toBe('2026-10')
    const b = await getCreditAccount(db, userId, OCTOBER + HOUR)
    expect(b.balance).toBe(100)

    // Exactly one grant.monthly ledger row.
    const rows = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    const grants = rows.filter((r) => r.kind === 'grant.monthly')
    expect(grants).toHaveLength(1)
    expect(grants[0].balanceAfter).toBe(100)

    // Parallel calls from a fresh user.
    const userId2 = `lazy-par-${crypto.randomUUID()}`
    await seedUser(db, userId2)
    const [c, d, e] = await Promise.all([
      getCreditAccount(db, userId2, OCTOBER),
      getCreditAccount(db, userId2, OCTOBER),
      getCreditAccount(db, userId2, OCTOBER),
    ])
    expect(c.balance).toBe(100)
    expect(d.balance).toBe(100)
    expect(e.balance).toBe(100)

    const rows2 = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId2))
    expect(rows2.filter((r) => r.kind === 'grant.monthly')).toHaveLength(1)
  })

  test('a user with no subscription row is granted the free allowance (100)', async () => {
    const db = createDb(env.DB)
    const userId = `nosub-${crypto.randomUUID()}`
    await seedUser(db, userId)
    const view = await getCreditAccount(db, userId, OCTOBER)
    expect(view.balance).toBe(100)
    expect(view.periodKey).toBe('2026-10')
  })
})

// ---------------------------------------------------------------------------
// 2. consumeCredits success
// ---------------------------------------------------------------------------
describe('2. consumeCredits success updates balance and ledger', () => {
  test('balance decreases, ledger row records balanceAfter', async () => {
    const db = createDb(env.DB)
    const userId = `consume-${crypto.randomUUID()}`
    await seedCreditUser(db, { userId, balance: 30 })

    const result = await consumeCredits(db, { userId, cost: 10 }, OCTOBER)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.balance).toBe(20)
      expect(result.balanceAfter).toBe(20)
    }

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(20)

    const rows = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    const consumes = rows.filter((r) => r.kind === 'consume')
    expect(consumes).toHaveLength(1)
    expect(consumes[0]?.delta).toBe(-10)
    expect(consumes[0]?.balanceAfter).toBe(20)
    expect(rows[0]?.kind).toBe('consume')
  })
})

// ---------------------------------------------------------------------------
// 3. insufficient_credits
// ---------------------------------------------------------------------------
describe('3. insufficient_credits leaves no ledger row and no balance change', () => {
  test('a debit larger than the balance is rejected', async () => {
    const db = createDb(env.DB)
    const userId = `insuff-${crypto.randomUUID()}`
    await seedCreditUser(db, { userId, balance: 5 })

    const result = await consumeCredits(db, { userId, cost: 10 }, OCTOBER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('insufficient_credits')

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(5)

    // The seed ledger row is present, but no CONSUME row was written.
    const rows = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    expect(rows.filter((r) => r.kind === 'consume')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. concurrent consumes never overdraft
// ---------------------------------------------------------------------------
describe('4. concurrent consumes never overdraft', () => {
  test('balance 30, cost 10, 10 concurrent → exactly 3 succeed, final balance 0', async () => {
    const db = createDb(env.DB)
    const userId = `conc-${crypto.randomUUID()}`
    await seedCreditUser(db, { userId, balance: 30 })

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        consumeCredits(db, { userId, cost: 10, idempotencyKey: `conc-${userId}-${i}` }, OCTOBER),
      ),
    )
    const okCount = results.filter((r) => r.ok).length
    expect(okCount).toBe(3)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'insufficient_credits')).toBe(true)

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(0)

    const rows = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    const consumes = rows.filter((r) => r.kind === 'consume')
    expect(consumes).toHaveLength(3)
    expect(consumes.every((r) => r.balanceAfter >= 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. idempotency replay
// ---------------------------------------------------------------------------
describe('5. idempotency replay', () => {
  test('the same idempotencyKey twice → one ledger row, same balanceAfter', async () => {
    const db = createDb(env.DB)
    const userId = `idem-${crypto.randomUUID()}`
    await seedCreditUser(db, { userId, balance: 50 })
    const key = `consume:${userId}:fixed`

    const first = await consumeCredits(db, { userId, cost: 10, idempotencyKey: key }, OCTOBER)
    const second = await consumeCredits(db, { userId, cost: 10, idempotencyKey: key }, OCTOBER)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok) expect(second.ok && second.balanceAfter).toBe(first.balanceAfter)

    const rows = await db.select().from(creditLedger).where(eq(creditLedger.idempotencyKey, key))
    expect(rows).toHaveLength(1)

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(40)
  })
})

// ---------------------------------------------------------------------------
// 6. cross-month rollover
// ---------------------------------------------------------------------------
describe('6. cross-month rollover', () => {
  test('a grant in period P, then a read in P+1 grants again without duplicating', async () => {
    const db = createDb(env.DB)
    const userId = `roll-${crypto.randomUUID()}`
    await seedUser(db, userId)

    // First read in October grants 100 for 2026-10.
    const oct = await getCreditAccount(db, userId, OCTOBER)
    expect(oct.balance).toBe(100)
    expect(oct.periodKey).toBe('2026-10')

    // A read in November rolls over to a fresh grant.
    const nov = await getCreditAccount(db, userId, NOVEMBER)
    expect(nov.balance).toBe(200) // 100 (Oct) + 100 (Nov)
    expect(nov.periodKey).toBe('2026-11')

    const rows = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    const grants = rows.filter((r) => r.kind === 'grant.monthly')
    expect(grants).toHaveLength(2)
    // The October grant was not duplicated.
    expect(grants.map((g) => g.idempotencyKey).sort()).toEqual([
      'monthly:' + userId + ':2026-10',
      'monthly:' + userId + ':2026-11',
    ])
  })
})

// ---------------------------------------------------------------------------
// 7. ownership
// ---------------------------------------------------------------------------
describe('7. ownership: ledger reads are scoped to the user', () => {
  test('listLedger(A) returns only A rows even when B has rows too', async () => {
    const db = createDb(env.DB)
    const userA = `own-a-${crypto.randomUUID()}`
    const userB = `own-b-${crypto.randomUUID()}`
    await seedCreditUser(db, { userId: userA, balance: 50 })
    await seedCreditUser(db, { userId: userB, balance: 70 })

    await consumeCredits(db, { userId: userA, cost: 10 }, OCTOBER)
    await consumeCredits(db, { userId: userB, cost: 20 }, OCTOBER)

    const ledgerA = await listLedger(db, userA, { page: 1, pageSize: 50 })
    // seed ledger row + the consume row.
    expect(ledgerA.total).toBe(2)
    expect(ledgerA.rows.every((r) => r.userId === userA)).toBe(true)

    const ledgerB = await listLedger(db, userB, { page: 1, pageSize: 50 })
    expect(ledgerB.total).toBe(2)
    expect(ledgerB.rows.every((r) => r.userId === userB)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8. grantCredits upgrade delta
// ---------------------------------------------------------------------------
describe('8. grantCredits grant.upgrade is idempotent', () => {
  test('the same upgrade idempotencyKey grants once', async () => {
    const db = createDb(env.DB)
    const userId = `upg-${crypto.randomUUID()}`
    await seedCreditUser(db, { userId, balance: 100, periodKey: '2026-10', periodGrant: 100 })

    const key = `upgrade:${userId}:2026-10`
    const first = await grantCredits(db, {
      userId,
      delta: 4_900,
      kind: 'grant.upgrade',
      idempotencyKey: key,
    }, OCTOBER)
    expect(first.granted).toBe(true)

    const second = await grantCredits(db, {
      userId,
      delta: 4_900,
      kind: 'grant.upgrade',
      idempotencyKey: key,
    }, OCTOBER)
    expect(second.granted).toBe(true) // replay reports the same result

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(5_000) // 100 + 4_900 once, not twice

    const rows = await db.select().from(creditLedger).where(eq(creditLedger.idempotencyKey, key))
    expect(rows).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// reconcileAccount
// ---------------------------------------------------------------------------
describe('reconcileAccount', () => {
  test('detects and repairs a drifted cached balance', async () => {
    const db = createDb(env.DB)
    const userId = `rec-${crypto.randomUUID()}`
    await seedCreditUser(db, { userId, balance: 100 })
    // Corrupt the cached balance directly (simulating drift).
    await db.update(creditAccount).set({ balance: 999 }).where(eq(creditAccount.userId, userId))

    const result = await reconcileAccount(db, userId)
    expect(result.drifted).toBe(true)
    expect(result.balance).toBe(100) // the ledger (seed row) is the truth

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(100)
  })

  test('reports no drift when the cache matches the ledger', async () => {
    const db = createDb(env.DB)
    const userId = `rec2-${crypto.randomUUID()}`
    await seedCreditUser(db, { userId, balance: 25 })
    await consumeCredits(db, { userId, cost: 5 }, OCTOBER)
    const result = await reconcileAccount(db, userId)
    expect(result.drifted).toBe(false)
    expect(result.balance).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// The CREDITS_ENABLED master switch: hiding the UI must not break the books.
// ---------------------------------------------------------------------------
describe('CREDITS_ENABLED switch', () => {
  test('the data layer keeps working while the UI is switched off', async () => {
    // The switch hides surfaces; it must NOT disable the ledger. Otherwise
    // flipping it off would strand a balance and a later refund could not claw
    // back (the refund path reads the ledger regardless).
    const db = createDb(env.DB)
    const userId = `off-${crypto.randomUUID()}`
    // `env` in the workers pool is mutable, but the generated Env type pins
    // CREDITS_ENABLED to the "" literal from wrangler.jsonc — write through a
    // widened view so the test can exercise the off branch.
    const mutableEnv = env as unknown as { CREDITS_ENABLED?: string }
    const original = mutableEnv.CREDITS_ENABLED
    mutableEnv.CREDITS_ENABLED = 'false'
    try {
      const { isCreditsEnabled } = await import('./credits-switch')
      expect(isCreditsEnabled(env)).toBe(false)

      // Granting and consuming still work end to end. (The guarded INSERT needs
      // an account row, which is exactly what a purchase grants against.)
      await seedCreditUser(db, { userId, balance: 0 })
      const granted = await grantCredits(db, {
        userId,
        delta: 40,
        kind: 'purchase',
        idempotencyKey: `credits:stripe:pi_off_${userId}`,
        ref: `pi_off_${userId}`,
      }, OCTOBER)
      expect(granted.granted).toBe(true)
      expect(granted.balance).toBe(40)

      const consumed = await consumeCredits(db, { userId, cost: 15 }, OCTOBER)
      expect(consumed.ok).toBe(true)

      // The ledger still reconciles to the cached balance.
      const rec = await reconcileAccount(db, userId)
      expect(rec.drifted).toBe(false)
      expect(rec.balance).toBe(25)
    } finally {
      mutableEnv.CREDITS_ENABLED = original
    }
  })
})

// Keep the constants referenced so the intent stays obvious.
void DAY

// ---------------------------------------------------------------------------
// 11. consume idempotency key: a ref dedupes, a missing ref does not
// ---------------------------------------------------------------------------
describe('11. consume idempotency key', () => {
  test('a stable ref makes a retry free — one ledger row, one charge', async () => {
    const db = createDb(env.DB)
    const userId = `ref-${crypto.randomUUID()}`
    await seedCreditUser(db, { userId, balance: 50 })
    const ref = `task-${crypto.randomUUID()}`

    const first = await consumeCredits(db, { userId, cost: 10, ref, note: 'transcribe' }, OCTOBER)
    // The caller retries the same unit of work (webhook redelivery, double
    // submit). It must not be charged again.
    const retry = await consumeCredits(db, { userId, cost: 10, ref, note: 'transcribe' }, OCTOBER)

    expect(first.ok).toBe(true)
    expect(retry.ok).toBe(true)
    if (first.ok && retry.ok) expect(retry.balanceAfter).toBe(first.balanceAfter)

    // `seedCreditUser` writes the opening balance as one `adjust` row, so look
    // only at the consumption rows.
    const rows = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    const consumes = rows.filter((r) => r.kind === 'consume')
    expect(consumes).toHaveLength(1)
    expect(consumes[0]?.ref).toBe(ref)
    expect(consumes[0]?.delta).toBe(-10)

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(40)
  })

  test('different refs charge separately', async () => {
    const db = createDb(env.DB)
    const userId = `ref2-${crypto.randomUUID()}`
    await seedCreditUser(db, { userId, balance: 50 })

    await consumeCredits(db, { userId, cost: 10, ref: 'task-a' }, OCTOBER)
    await consumeCredits(db, { userId, cost: 10, ref: 'task-b' }, OCTOBER)

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(30)
  })

  test('a charge with no ref and no explicit key still charges every call', async () => {
    // The documented escape hatch (the demo task does this deliberately): there
    // is no unit of work to dedupe on, so each call is its own charge.
    const db = createDb(env.DB)
    const userId = `noref-${crypto.randomUUID()}`
    await seedCreditUser(db, { userId, balance: 50 })

    await consumeCredits(db, { userId, cost: 10 }, OCTOBER)
    await consumeCredits(db, { userId, cost: 10 }, OCTOBER)

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(30)
  })

  test('consumeIdempotencyKey derives the same key from the same ref', () => {
    const a = consumeIdempotencyKey({ userId: 'u1', ref: 'task-1' })
    const b = consumeIdempotencyKey({ userId: 'u1', ref: 'task-1' })
    expect(a).toBe('consume:u1:task-1')
    expect(a).toBe(b)
    // No ref → a fresh random key, i.e. no dedupe. Documented, not accidental.
    expect(consumeIdempotencyKey({ userId: 'u1', ref: null }))
      .not.toBe(consumeIdempotencyKey({ userId: 'u1', ref: null }))
  })

  test('a non-positive cost is refused', async () => {
    const db = createDb(env.DB)
    const userId = `bad-${crypto.randomUUID()}`
    await seedCreditUser(db, { userId, balance: 10 })
    await expect(consumeCredits(db, { userId, cost: 0 }, OCTOBER)).rejects.toThrow(/positive/)
    await expect(consumeCredits(db, { userId, cost: -5 }, OCTOBER)).rejects.toThrow(/positive/)
  })
})
