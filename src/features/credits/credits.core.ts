/**
 * Credits core — the pure, node-testable half of the credits slice.
 *
 * No env, no SDK, no DB. It answers the pure questions: which UTC month a
 * timestamp falls in, how many credits each plan grants monthly, how an
 * inbound purchase classifies, and whether a vendor is allowed to sell a
 * given credit pack.
 */
import type { Plan, PlanTier } from '../billing/plans'
import { planTiers } from '../billing/plans'
import type { Locale } from '@/features/i18n/locale'
import type { BillingEnv } from '../billing/providers/registry'
import { disabledProviderReason, hasRequiredSecrets } from '../billing/providers/registry'
import type { ProviderId } from '../billing/providers/catalog'
import type { CreditPack } from './credit-packs'
import { packForProduct } from './credit-packs'

/** One demo task costs this many credits. */
export const DEMO_TASK_COST = 5

/**
 * UTC calendar month as `YYYY-MM`.
 *
 * The period is UTC by design: grants are accounted per calendar month, and
 * mixing in the user's timezone would make "when did this user last get paid"
 * depend on where they happened to be. Keep it boring and deterministic.
 */
export function periodKeyFor(now: number): string {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Monthly grant for a plan, read from the plan tier itself.
 *
 * `plans.ts` is the single source of truth for how many credits a plan grants —
 * the number lives on the tier (`credits.monthlyGrant`) next to its name and
 * price, so this slice must not keep a second copy of it.
 */
export function monthlyGrantFor(plan: Plan): number {
  const tier = planTiers.find((t) => t.id === plan)
  return tier?.credits.monthlyGrant ?? 0
}

/**
 * The plan credits are granted for a user.
 *
 * Admins bypass the paywall (aligned with `hasProAccess`), so they are granted
 * at the enterprise tier. Everyone else uses their subscription plan.
 */
export function effectivePlanForCredits(role: string | null | undefined, plan: Plan): Plan {
  return role === 'admin' ? 'enterprise' : plan
}

/**
 * Upgrade proration for the current month.
 *
 * The monthly grant is a fixed allowance; upgrading mid-period should top it up
 * to the new tier's allowance rather than wait for next month. If the old tier
 * already granted at least the new tier's allowance, there is nothing to add.
 */
export function upgradeDeltaFor(prevPeriodGrant: number, newPlan: Plan): number {
  return Math.max(0, monthlyGrantFor(newPlan) - prevPeriodGrant)
}

/**
 * Classification of an inbound purchase event.
 *
 * `credits` when the product id maps to a credit pack, `lifetime` for a
 * subscription/plan purchase (routed to billing), `unknown` when the product
 * id is not ours at all.
 */
export type PurchaseClass =
  | { kind: 'credits'; pack: CreditPack }
  | { kind: 'lifetime' }
  | { kind: 'unknown' }

/**
 * Classify a purchase by provider + product id.
 *
 * The product id is the single authority (see `packForProduct`); metadata is
 * not consulted. A null/empty product id is `unknown`, not `lifetime`, because
 * "no product id at all" cannot prove a plan purchase either.
 */
export function classifyPurchase(providerId: ProviderId, productId: string | null | undefined): PurchaseClass {
  const pack = packForProduct(providerId, productId)
  if (pack) return { kind: 'credits', pack }
  // A non-empty product id that is not a credit pack is a plan/lifetime buy.
  // An empty one is unknown — we have no evidence of what was purchased.
  return productId ? { kind: 'lifetime' } : { kind: 'unknown' }
}

export type PackResolution = { ok: true; productId: string } | { ok: false; reason: string }

/**
 * The single authority on "can this vendor sell this credit pack?".
 *
 * Checks, in order: the provider switch → the vendor's secrets → the pack's
 * configured product id for that vendor → and finally the PayPal `P-` guard
 * (a `P-` prefixed id is a subscription plan id and would take the subscription
 * path, not the credit path). `reason` is operator-actionable English, matching
 * `resolvePurchase`.
 */
export function resolveCreditPack(env: BillingEnv, pack: CreditPack, provider: ProviderId): PackResolution {
  const notForSale = disabledProviderReason(env, provider)
  if (notForSale) return { ok: false, reason: notForSale }

  if (!hasRequiredSecrets(env, provider)) {
    return { ok: false, reason: `Provider "${provider}" is enabled but its secrets are not set on this Worker.` }
  }

  const productId = pack.productIds[provider]
  if (!productId) {
    return { ok: false, reason: `Provider "${provider}" does not sell the "${pack.id}" credit pack.` }
  }

  // PayPal routes on the `P-` prefix. An id without it silently becomes a
  // one-time order that PayPal then rejects, so refuse it up front — the same
  // guard `resolvePurchase` applies to subscription plans.
  if (provider === 'paypal' && productId.startsWith('P-')) {
    return {
      ok: false,
      reason: `The PayPal product id for the "${pack.id}" credit pack must not start with "P-" (that is a subscription plan id); plans.ts has "${productId}".`,
    }
  }

  return { ok: true, productId }
}

// Re-exported so callers can reach the tier type without a second import.
export type { Plan, PlanTier, Locale, ProviderId }
