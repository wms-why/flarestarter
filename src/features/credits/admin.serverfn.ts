/**
 * Credits admin server fns — account listing, ledger inspection and manual
 * adjustments. All gated by `assertCreditsAdmin` (admin role *and* the
 * `CREDITS_ENABLED` switch; 404 for non-admins so the console stays invisible),
 * matching the rest of `src/features/admin`.
 *
 * Written in a separate module so vendor SDKs and `@/lib/env` stay out of any
 * route file that imports these.
 */
import { createServerFn } from '@tanstack/react-start'
import { count, desc, eq, or, sql } from 'drizzle-orm'
import { clampPage, clampPageSize } from '@/features/admin/params'
import { assertAdmin } from '@/features/admin/assert-admin.server'
import { user } from '@/features/auth/auth.schema'
import { creditAccount, creditLedger } from './credits.schema'
import { grantCredits } from './credits.server'

export interface AdminCreditAccountRow {
  userId: string
  email: string
  name: string
  balance: number
  periodKey: string | null
  periodGrant: number
  lifetimePurchased: number
  lifetimeConsumed: number
  createdAt: Date | string
}

export interface AdminCreditLedgerRow {
  id: string
  userId: string
  delta: number
  balanceAfter: number
  kind: string
  ref: string | null
  note: string | null
  createdAt: Date | string
}

/**
 * Gate for every admin credits handler: admin role **and** the credits switch.
 *
 * Ordered deliberately — `assertAdmin` first so a non-admin still gets a 404
 * rather than learning whether the deployment has credits turned on.
 *
 * The switch check is not redundant with the route loader: `/admin/credits`
 * 404s when credits are off, but these server fns are separate endpoints. With
 * the switch off the operator has removed the feature; an admin console that
 * still answers ledger queries (or accepts manual adjustments) contradicts that.
 */
async function assertCreditsAdmin(): Promise<{ id: string }> {
  const admin = await assertAdmin()
  const { assertCreditsEnabled } = await import('./credits-switch')
  const { env } = await import('@/lib/env')
  assertCreditsEnabled(env)
  return admin
}

export const getAdminCredits = createServerFn({ method: 'GET' })
  .validator((d: { q?: string; page?: number; pageSize?: number }) => ({
    q: typeof d?.q === 'string' ? d.q.slice(0, 200) : undefined,
    page: clampPage(d?.page),
    pageSize: clampPageSize(d?.pageSize),
  }))
  .handler(async ({ data }): Promise<{ rows: AdminCreditAccountRow[]; total: number }> => {
    // Gate every admin read ourselves rather than trusting the parent route
    // loader — a server fn is a network endpoint and can be reached directly.
    await assertCreditsAdmin()
    const { createDb } = await import('@/db/client')
    const db = createDb((await import('@/lib/env')).env.DB)

    const pattern = data.q ? `%${data.q.replace(/[%_!]/g, '!$&')}%` : null
    const where = pattern
      ? or(sql`${user.email} LIKE ${pattern} ESCAPE '!'`, sql`${user.name} LIKE ${pattern} ESCAPE '!'`)
      : undefined

    const [listed, [{ c: total }]] = await Promise.all([
      db
        .select({
          userId: creditAccount.userId,
          email: user.email,
          name: user.name,
          balance: creditAccount.balance,
          periodKey: creditAccount.periodKey,
          periodGrant: creditAccount.periodGrant,
          lifetimePurchased: creditAccount.lifetimePurchased,
          lifetimeConsumed: creditAccount.lifetimeConsumed,
          createdAt: creditAccount.createdAt,
        })
        .from(creditAccount)
        .innerJoin(user, eq(user.id, creditAccount.userId))
        .where(where)
        .orderBy(desc(creditAccount.balance))
        .limit(data.pageSize)
        .offset(data.page * data.pageSize),
      db.select({ c: count() }).from(creditAccount).where(where),
    ])

    return { rows: listed, total: Number(total) }
  })

export const getAdminLedger = createServerFn({ method: 'GET' })
  .validator((d: { userId?: string; page?: number; pageSize?: number }) => ({
    userId: typeof d?.userId === 'string' && d.userId ? d.userId : undefined,
    page: clampPage(d?.page),
    pageSize: clampPageSize(d?.pageSize),
  }))
  .handler(async ({ data }): Promise<{ rows: AdminCreditLedgerRow[]; total: number }> => {
    await assertCreditsAdmin()
    const { createDb } = await import('@/db/client')
    const db = createDb((await import('@/lib/env')).env.DB)

    const where = data.userId ? eq(creditLedger.userId, data.userId) : undefined
    const [listed, [{ c: total }]] = await Promise.all([
      db
        .select({
          id: creditLedger.id,
          userId: creditLedger.userId,
          delta: creditLedger.delta,
          balanceAfter: creditLedger.balanceAfter,
          kind: creditLedger.kind,
          ref: creditLedger.ref,
          note: creditLedger.note,
          createdAt: creditLedger.createdAt,
        })
        .from(creditLedger)
        .where(where)
        .orderBy(desc(creditLedger.createdAt))
        .limit(data.pageSize)
        .offset(data.page * data.pageSize),
      db.select({ c: count() }).from(creditLedger).where(where),
    ])

    return { rows: listed, total: Number(total) }
  })

/**
 * Manually adjust a user's balance.
 *
 * Deltas are validated before they touch the DB: zero is a no-op with a clear
 * meaning ("you meant to type something"), non-integers and NaN are refused,
 * and a negative delta that would overdraft is clamped to the available
 * balance so the account can never go below zero — the actual applied amount is
 * recorded in the note, which is the auditable truth in the ledger.
 */
export const adjustCredits = createServerFn({ method: 'POST' })
  .validator((d: { userId: string; delta: number; note: string }) => d)
  .handler(async ({ data }): Promise<void> => {
    const admin = await assertCreditsAdmin()

    if (!Number.isFinite(data.delta) || !Number.isInteger(data.delta)) {
      throw new Error('Delta must be a whole number of credits.')
    }
    if (data.delta === 0) {
      throw new Error('Delta must be non-zero.')
    }

    const { createDb } = await import('@/db/client')
    const { env } = await import('@/lib/env')
    const db = createDb(env.DB)

    const rows = await db.select({ balance: creditAccount.balance }).from(creditAccount)
      .where(eq(creditAccount.userId, data.userId))
    if (rows.length === 0) throw new Error('No credit account for that user.')
    const balance = rows[0].balance

    let delta = data.delta
    let note = data.note
    if (delta < 0 && balance + delta < 0) {
      // Clamp instead of refusing: an admin trying to claw back more than the
      // balance is usually a data-entry slip, and the applied amount in the
      // ledger note preserves exactly what happened.
      delta = Math.max(-balance, delta)
      note = [data.note, `clamped from ${data.delta} to ${delta} (balance would not go below 0)`]
        .filter(Boolean)
        .join(' — ')
    }

    await grantCredits(
      db,
      {
        userId: data.userId,
        delta,
        kind: 'adjust',
        idempotencyKey: `adjust:${admin.id}:${crypto.randomUUID()}`,
        ref: admin.id,
        note,
      },
      Date.now(),
    )
  })

// Re-exported for route typing convenience.
export type { AdminCreditAccountRow as CreditsAdminRow }
