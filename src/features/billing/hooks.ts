import { eq } from 'drizzle-orm'
import type { DB } from '@/db/client'
import { user } from '@/features/auth/auth.schema'
import { subscription } from './billing.schema'
import { asPlan } from './plans'
import { ownedBy, scopeFromUser } from '@/db/scope'
import type { BillingTransition } from './entitlement'

export interface BillingHookContext {
  db: DB
  userId: string
  email: string
}

/** Edit this file to attach your own post-billing-event callbacks. */
export interface BillingHooks {
  onProActivated?(ctx: BillingHookContext, via: 'subscription' | 'lifetime'): Promise<void>
  onProDeactivated?(ctx: BillingHookContext, reason: 'canceled' | 'refunded' | 'past_due'): Promise<void>
  /** 续费扣款失败（invoice.payment_failed）。重试邮件交给 Stripe；这里多用于站内/Slack 提醒等副作用。 */
  onPaymentFailed?(ctx: BillingHookContext): Promise<void>
}

// ── Default hooks (example) ──────────────────────────────────────────────
// Replace/extend these with your own side effects. They run best-effort after
// the entitlement is committed; a failure here never fails the Stripe webhook.
export const billingHooks: BillingHooks = {
  async onProActivated(ctx) {
    // Example: send a confirmation email (dev: captured to console; prod: Resend).
    // 已知限制：webhook 无请求上下文可协商语言，而 user 表未持久化 locale 偏好，只能
    // 固定 'en'（zh 用户也收英文确认邮件）。要修：给 user 表加 locale 列（注册/切换语言
    // 时落库），此处改读 ctx 用户的存量偏好。
    const { env } = await import('@/lib/env')
    const { sendEmail } = await import('@/features/email/email.server')
    const base = new URL(env.BETTER_AUTH_URL).origin
    await sendEmail({ to: ctx.email, locale: 'en', template: 'pro-activated', data: { url: `${base}/app` } })

    // Best-effort credit upgrade grant. Plan upgrades top up the current UTC
    // month's allowance to the new tier's (e.g. free 100 → pro 5_000 = +4_900).
    // The user may have no subscription row before this event, so read the row
    // that was just written; never let this throw the webhook.
    try {
      const { creditAccount } = await import('@/features/credits/credits.schema')
      const { grantCredits } = await import('@/features/credits/credits.server')
      const { upgradeDeltaFor } = await import('@/features/credits/credits.core')

      // `ctx.userId` is a free user's id (no subscription row), so read the plan
      // straight off the subscription row rather than `getCreditAccount`, which
      // would lazy-grant the new tier first and make the delta zero.
      const rows = await ctx.db
        .select({ plan: subscription.plan, lifetime: subscription.lifetime })
        .from(subscription)
        .where(ownedBy(subscription, scopeFromUser(ctx.userId)))
      const plan = rows[0]?.lifetime ? 'pro' : (asPlan(rows[0]?.plan ?? 'free') ?? 'free')

      // `getCreditAccount` lazily grants the monthly allowance, which would both
      // double-count and record a `grant.monthly` row instead of `grant.upgrade`.
      // Read the period grant directly instead.
      const accountRows = await ctx.db
        .select({ periodGrant: creditAccount.periodGrant, periodKey: creditAccount.periodKey })
        .from(creditAccount)
        .where(eq(creditAccount.userId, ctx.userId))
      const account = accountRows[0]
      const grant = upgradeDeltaFor(account?.periodGrant ?? 0, plan)
      if (grant > 0) {
        await grantCredits(ctx.db, {
          userId: ctx.userId,
          delta: grant,
          kind: 'grant.upgrade',
          idempotencyKey: `upgrade:${ctx.userId}:${account?.periodKey ?? 'none'}:${plan}`,
          ref: null,
          note: `plan upgraded to ${plan}`,
        }, Date.now())
      }
    } catch (e) {
      // Best-effort: a credit-grant failure must never fail the billing webhook.
      console.error('[billing-hooks] credit upgrade grant failed', e)
    }
  },
  // async onProDeactivated(ctx, reason) {
  //   // Example: revoke provisioned resources, send a "your Pro ended" email, etc.
  // },
  // async onPaymentFailed(ctx) {
  //   // Example: ping Slack, or send an extra nudge. Stripe already emails the
  //   // customer + retries; the in-app banner is driven by entitlement.paymentFailed.
  // },
}

async function getUserEmail(db: DB, userId: string): Promise<string | null> {
  const rows = await db.select({ email: user.email }).from(user).where(eq(user.id, userId))
  return rows[0]?.email ?? null
}

/** Resolve the user's email and dispatch the matching hook. Best-effort: never throws. */
export async function runBillingHooks(db: DB, t: BillingTransition, hooks: BillingHooks = billingHooks): Promise<void> {
  try {
    const email = await getUserEmail(db, t.userId)
    if (!email) return
    const ctx: BillingHookContext = { db, userId: t.userId, email }
    if (t.kind === 'activated') await hooks.onProActivated?.(ctx, t.via)
    else if (t.kind === 'deactivated') await hooks.onProDeactivated?.(ctx, t.reason)
    else await hooks.onPaymentFailed?.(ctx)
  } catch (e) {
    console.error('[billing-hooks] runBillingHooks failed', e)
  }
}
