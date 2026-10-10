/**
 * Pure aggregate function for admin stats — no react-start / server-fn imports.
 * Safe to import in both workers and node environments.
 */
import { count, gt } from 'drizzle-orm'
import type { DB } from '@/db/client'
import { user, session } from '@/features/auth/auth.schema'
import { subscription } from '@/features/billing/billing.schema'
import { isPaidPlanId } from '@/features/admin/plan-label'

export interface AdminStats {
  totalUsers: number
  activeUsers: number
  subscriptions: { active: number; pastDue: number; canceled: number; pro: number; free: number }
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
  return { totalUsers, activeUsers, subscriptions }
}
