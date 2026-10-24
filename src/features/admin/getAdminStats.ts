/**
 * Pure aggregate function for admin stats — no react-start / server-fn imports.
 * Safe to import in both workers and node environments.
 */
import { count, gt, lt, sum } from 'drizzle-orm'
import type { DB } from '@/db/client'
import { user, session } from '@/features/auth/auth.schema'
import { subscription } from '@/features/billing/billing.schema'
import { creditAccount, creditLedger } from '@/features/credits/credits.schema'
import { isPaidPlanId } from '@/features/admin/plan-label'

export interface AdminStats {
  totalUsers: number
  activeUsers: number
  subscriptions: { active: number; pastDue: number; canceled: number; pro: number; free: number }
  /**
   * null when the credits feature is switched off (`CREDITS_ENABLED` unset) —
   * the dashboard then omits the credit cards entirely rather than showing
   * three rows of zeros for a feature that isn't enabled.
   */
  credits: { outstanding: number; issued: number; consumed: number } | null
}

/**
 * 跨用户统计（admin 特权视图，角色门控后调用）。
 * now: epoch ms（调用方传 Date.now()；测试可注入固定值）。
 */
export async function getAdminStats(db: DB, now: number): Promise<AdminStats> {
  const [{ c: totalUsers }] = await db.select({ c: count() }).from(user)
  const activeRows = await db.select({ uid: session.userId }).from(session).where(gt(session.expiresAt, new Date(now)))
  const activeUsers = new Set(activeRows.map((r) => r.uid)).size
  const subs = await db.select({ status: subscription.status, plan: subscription.plan }).from(subscription)
  const subscriptions = {
    active: subs.filter((s) => s.status === 'active').length,
    pastDue: subs.filter((s) => s.status === 'past_due').length,
    canceled: subs.filter((s) => s.status === 'canceled').length,
    // Counted by tier order, so an enterprise row counts as paying like any
    // other tier above free.
    pro: subs.filter((s) => isPaidPlanId(s.plan)).length,
    free: subs.filter((s) => !isPaidPlanId(s.plan)).length,
  }

  // Credits: the materialized balance column is summed; issued/consumed are the
  // signed halves of the append-only ledger. SQLite SUM over an empty set is
  // NULL, so fall back to 0. Skipped whole when the feature is off — three D1
  // reads nobody will see.
  const { isCreditsEnabled } = await import('@/features/credits/credits-switch')
  const { env } = await import('@/lib/env')
  const credits = isCreditsEnabled(env)
    ? await countCredits(db)
    : null

  return { totalUsers, activeUsers, subscriptions, credits }
}

/** Sum the credit tables for the dashboard. Split out so the switch can skip it. */
async function countCredits(db: DB): Promise<{ outstanding: number; issued: number; consumed: number }> {
  const [[balanceRow], [issuedRow], [consumedRow]] = await Promise.all([
    db.select({ total: sum(creditAccount.balance) }).from(creditAccount),
    db.select({ total: sum(creditLedger.delta) }).from(creditLedger).where(gt(creditLedger.delta, 0)),
    db.select({ total: sum(creditLedger.delta) }).from(creditLedger).where(lt(creditLedger.delta, 0)),
  ])
  return {
    outstanding: Number(balanceRow?.total ?? 0),
    issued: Number(issuedRow?.total ?? 0),
    consumed: Number(consumedRow?.total ?? 0),
  }
}
