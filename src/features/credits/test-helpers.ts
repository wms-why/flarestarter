/**
 * Test helpers for credits workers integration tests.
 *
 * Provides:
 * - applyCreditsSchema: creates user, credit_account, credit_ledger tables
 *   in the test D1 (idempotent via IF NOT EXISTS). Mirrors the generated
 *   migration for the credits slice.
 * - seedUser: inserts a bare user row.
 * - seedCreditUser: inserts a user row + a credit_account row.
 */
import type { DB } from '@/db/client'
import { rawD1 } from '@/db/raw'
import { creditAccount, creditLedger } from './credits.schema'

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------
export async function applyCreditsSchema(d1: D1Database): Promise<void> {
  const stmts = [
    // user table (needed so the credit tables' FKs resolve)
    `CREATE TABLE IF NOT EXISTS "user" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "name" TEXT NOT NULL,
      "email" TEXT NOT NULL UNIQUE,
      "email_verified" INTEGER DEFAULT 0 NOT NULL,
      "image" TEXT,
      "created_at" INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
      "updated_at" INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
      "role" TEXT,
      "banned" INTEGER DEFAULT false,
      "ban_reason" TEXT,
      "ban_expires" INTEGER
    )`,

    // subscription table (the lazy plan lookup in getCreditAccount reads it via
    // getEntitlementFor; mirror the billing schema so the credits tests are
    // self-contained).
    `CREATE TABLE IF NOT EXISTS "subscription" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "user_id" TEXT NOT NULL UNIQUE,
      "provider" TEXT NOT NULL DEFAULT 'stripe',
      "customer_id" TEXT,
      "subscription_id" TEXT,
      "status" TEXT NOT NULL DEFAULT 'none',
      "plan" TEXT NOT NULL DEFAULT 'free',
      "price_id" TEXT,
      "current_period_end" INTEGER,
      "cancel_at_period_end" INTEGER NOT NULL DEFAULT 0,
      "lifetime" INTEGER NOT NULL DEFAULT 0,
      "lifetime_payment_ref" TEXT,
      "payment_failed_at" INTEGER,
      "last_event_at" INTEGER,
      "created_at" INTEGER NOT NULL,
      "updated_at" INTEGER NOT NULL,
      FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
    )`,

    // credit_account table
    `CREATE TABLE IF NOT EXISTS "credit_account" (
      "user_id" TEXT PRIMARY KEY NOT NULL,
      "balance" INTEGER NOT NULL DEFAULT 0,
      "period_key" TEXT,
      "period_grant" INTEGER NOT NULL DEFAULT 0,
      "lifetime_purchased" INTEGER NOT NULL DEFAULT 0,
      "lifetime_consumed" INTEGER NOT NULL DEFAULT 0,
      "created_at" INTEGER NOT NULL,
      "updated_at" INTEGER NOT NULL,
      FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
    )`,

    // credit_ledger table
    `CREATE TABLE IF NOT EXISTS "credit_ledger" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "user_id" TEXT NOT NULL,
      "delta" INTEGER NOT NULL,
      "balance_after" INTEGER NOT NULL,
      "kind" TEXT NOT NULL,
      "idempotency_key" TEXT NOT NULL UNIQUE,
      "ref" TEXT,
      "note" TEXT,
      "created_at" INTEGER NOT NULL,
      FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
    )`,

    // Mirror the drizzle-generated indexes.
    `CREATE INDEX IF NOT EXISTS "credit_ledger_user_created_idx" ON "credit_ledger" ("user_id", "created_at")`,
    `CREATE INDEX IF NOT EXISTS "credit_ledger_ref_idx" ON "credit_ledger" ("ref")`,
  ]

  for (const sql of stmts) {
    await d1.prepare(sql).run()
  }
}

// ---------------------------------------------------------------------------
// seedUser
// ---------------------------------------------------------------------------
export async function seedUser(db: DB, userId: string, role?: string | null): Promise<void> {
  const d1 = rawD1(db)
  await d1
    .prepare(
      `INSERT OR IGNORE INTO "user" ("id","name","email","email_verified","created_at","updated_at","role")
       VALUES (?,?,?,0,?,?,?)`,
    )
    .bind(userId, userId, `${userId}@test.example`, Date.now(), Date.now(), role ?? null)
    .run()
}

// ---------------------------------------------------------------------------
// seedCreditUser
// ---------------------------------------------------------------------------
export interface SeedCreditUserOptions {
  userId: string
  balance?: number
  periodKey?: string | null
  periodGrant?: number
  role?: string | null
}

export async function seedCreditUser(
  db: DB,
  opts: SeedCreditUserOptions,
): Promise<{ userId: string }> {
  const {
    userId,
    balance = 0,
    periodKey = null,
    periodGrant = 0,
    role = null,
  } = opts

  await seedUser(db, userId, role)

  const now = Date.now()
  await db.insert(creditAccount).values({
    userId,
    balance,
    periodKey: periodKey ?? undefined,
    periodGrant,
    lifetimePurchased: 0,
    lifetimeConsumed: 0,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  })

  // Write the initial balance as a ledger row so the ledger is the source of
  // truth (reconcileAccount recomputes balance from the ledger).
  await db.insert(creditLedger).values({
    id: crypto.randomUUID(),
    userId,
    delta: balance,
    balanceAfter: balance,
    kind: 'adjust',
    idempotencyKey: `seed:${userId}:initial`,
    ref: null,
    note: 'initial seed balance',
    createdAt: new Date(now),
  })

  return { userId }
}
