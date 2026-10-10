/**
 * Billing provider registry.
 *
 * Answers two questions:
 *   1. **Which providers are switched on?** `BILLING_PROVIDERS`.
 *   2. **Which of those are actually usable right now?** secret presence.
 *
 * The two are deliberately different. The switch is an operator intent ("we
 * take Waffo and PayPal"), the secret gate is an operational fact ("Creem's
 * keys are on this Worker"). A provider must pass both to render a button.
 *
 * Adding a vendor is additive: implement `PaymentProvider`, add a case to
 * `getBillingProvider`, and add the provider to `providers/catalog.ts`.
 */
import type { PlanTier, Interval } from '../plans'
import { priceFor } from '../plans'
import type { PaymentProvider } from '../payment'
import { PROVIDER_CATALOG, PROVIDER_IDS, isProviderId, type ProviderId } from './catalog'
import { createCreemProvider } from './creem'
import { isSubscriptionPlanId } from './paypal'
import { createPaypalProvider } from './paypal'
import { createStripeProvider } from './stripe'
import { createWaffoProvider } from './waffo'

/** The env surface every factory reads. Kept structural so tests can pass a stub. */
export interface BillingEnv {
  BILLING_PROVIDERS?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  WAFFO_MERCHANT_ID?: string
  WAFFO_PRIVATE_KEY?: string
  WAFFO_PRIVATE_KEY_BASE64?: string
  WAFFO_WEBHOOK_PUBLIC_KEY?: string
  WAFFO_ENV?: string
  CREEM_API_KEY?: string
  CREEM_WEBHOOK_SECRET?: string
  CREEM_ENV?: string
  PAYPAL_CLIENT_ID?: string
  PAYPAL_CLIENT_SECRET?: string
  PAYPAL_WEBHOOK_ID?: string
  PAYPAL_ENV?: string
}

/**
 * Parse `BILLING_PROVIDERS` — a comma-separated list of provider ids.
 *
 * Whitespace is trimmed, empty entries dropped, duplicates de-duplicated while
 * preserving first-seen order (so the display order matches what the operator
 * wrote), and unknown ids discarded rather than crashing the page.
 *
 * **Unset or empty means all four**, not none. Each is still secret-gated, so
 * this cannot enable anything the operator has not configured — and it means a
 * fresh install that sets, say, Creem keys gets a working checkout without
 * having to discover this variable first. Turning a provider off is explicit:
 * remove its id from the list.
 */
export function parseEnabledProviders(raw: string | null | undefined): ProviderId[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [...PROVIDER_IDS]
  const seen = new Set<ProviderId>()
  const out: ProviderId[] = []
  for (const part of raw.split(',')) {
    const id = part.trim()
    if (!id || !isProviderId(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  // A list of nothing but commas/whitespace is a typo, not an intent to disable
  // every provider — fall back the same way an unset var does.
  return out.length > 0 ? out : [...PROVIDER_IDS]
}

/**
 * `key` arrives as a plain string from `catalog.requiredEnv`, which is
 * deliberately env-agnostic so the client bundle can import it. The cast keeps
 * that decoupling without weakening the env type everywhere else.
 */
function has(env: BillingEnv, key: string): boolean {
  const value = env[key as keyof BillingEnv]
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Whether a provider's own secrets are all present.
 *
 * Waffo is the one provider with a per-vendor subtlety: its private key has two
 * accepted encodings, so "at least one of these two" counts as satisfied.
 */
export function hasRequiredSecrets(env: BillingEnv, id: ProviderId): boolean {
  for (const key of PROVIDER_CATALOG[id].requiredEnv) {
    if (!has(env, key)) return false
  }
  if (id === 'waffo' && !has(env, 'WAFFO_PRIVATE_KEY') && !has(env, 'WAFFO_PRIVATE_KEY_BASE64')) return false
  return true
}

export function getBillingProvider(env: BillingEnv, id: ProviderId): PaymentProvider {
  switch (id) {
    case 'stripe':
      return createStripeProvider(env as { STRIPE_SECRET_KEY: string; STRIPE_WEBHOOK_SECRET: string })
    case 'waffo':
      return createWaffoProvider(env as Parameters<typeof createWaffoProvider>[0])
    case 'creem':
      return createCreemProvider(env as Parameters<typeof createCreemProvider>[0])
    case 'paypal':
      return createPaypalProvider(env as Parameters<typeof createPaypalProvider>[0])
  }
}

/**
 * Providers that are both switched on and fully configured.
 *
 * Construction is wrapped because a misconfigured provider (malformed PEM,
 * expired key) must degrade to "no button for this one" rather than take down
 * a marketing page or a checkout loader.
 */
export function listAvailableProviders(env: BillingEnv): PaymentProvider[] {
  const enabled = new Set(parseEnabledProviders(env.BILLING_PROVIDERS))
  const out: PaymentProvider[] = []
  for (const id of PROVIDER_IDS) {
    if (!enabled.has(id) || !hasRequiredSecrets(env, id)) continue
    try {
      out.push(getBillingProvider(env, id))
    } catch (err) {
      console.error(`[billing] ${id} provider is enabled and configured but failed to construct`, err)
    }
  }
  return out
}

export function getEnabledProviderIds(env: BillingEnv): ProviderId[] {
  return listAvailableProviders(env).map((p) => p.id)
}

/**
 * Providers that can actually sell this tier at this interval: live in the
 * registry **and** have a non-empty product id for that cell in `plans.ts`.
 *
 * This is the single check behind the checkout buttons, and it is re-run on the
 * server before any session is created — the page's rendering of it is a
 * convenience, not the security boundary.
 */
export function availableProvidersForTier(env: BillingEnv, tier: PlanTier, interval: Interval): PaymentProvider[] {
  const productIds = priceFor(tier, interval).productIds
  return listAvailableProviders(env).filter((p) => !!productIds[p.id])
}

/** Product id for a provider/tier/interval, or `null` when unconfigured. */
function productIdFor(env: BillingEnv, tier: PlanTier, interval: Interval, provider: ProviderId): string | null {
  if (!parseEnabledProviders(env.BILLING_PROVIDERS).includes(provider)) return null
  if (!hasRequiredSecrets(env, provider)) return null
  const id = priceFor(tier, interval).productIds[provider]
  return id ? id : null
}

export type PurchaseResolution =
  | { ok: true; productId: string }
  | { ok: false; reason: string }

/**
 * The single authority on "can this vendor sell this tier at this interval?".
 *
 * Both the checkout page (which decides which buttons to render) and
 * `startCheckout` (which creates the real session) call THIS, so the two can
 * never drift — a button that renders is a button that works, and a
 * hand-crafted POST gets exactly the same verdict the page showed.
 *
 * `reason` is operator-actionable on purpose: it is rendered verbatim on the
 * checkout page when someone deep-links `?provider=…`, so it names the missing
 * env vars or the offending config rather than saying "unavailable".
 */
export function resolvePurchase(
  env: BillingEnv,
  tier: PlanTier,
  interval: Interval,
  provider: ProviderId,
): PurchaseResolution {
  const notForSale = disabledProviderReason(env, provider)
  if (notForSale) return { ok: false, reason: notForSale }

  const productId = productIdFor(env, tier, interval, provider)
  if (!productId) {
    return { ok: false, reason: `Provider "${provider}" does not sell ${tier.id} on the ${interval} plan.` }
  }
  // PayPal routes on the `P-` prefix. An id without it silently becomes a
  // one-time order that PayPal then rejects, so refuse it up front — on the
  // render path too, or we would draw a button that always errors.
  if (provider === 'paypal' && !isSubscriptionPlanId(productId)) {
    return {
      ok: false,
      reason: `PayPal plan id for ${tier.id} must start with "P-" (a subscription plan id), but plans.ts has "${productId}".`,
    }
  }
  return { ok: true, productId }
}

/**
 * Providers that are switched on in `BILLING_PROVIDERS` but not usable, with the
 * reason. Drives the actionable error on `/checkout?provider=…` so an operator
 * sees which env var to set instead of a silent empty button.
 */
export function disabledProviderReason(env: BillingEnv, id: ProviderId): string | null {
  if (!parseEnabledProviders(env.BILLING_PROVIDERS).includes(id)) {
    return `Provider "${id}" is not listed in BILLING_PROVIDERS.`
  }
  if (!hasRequiredSecrets(env, id)) {
    const missing = PROVIDER_CATALOG[id].requiredEnv.filter((k) => !has(env, k))
    const waffoKeyGap = id === 'waffo' && !has(env, 'WAFFO_PRIVATE_KEY') && !has(env, 'WAFFO_PRIVATE_KEY_BASE64')
    return `Provider "${id}" is listed in BILLING_PROVIDERS but its secrets are not set on this Worker. ` +
      `Set ${[...missing, ...(waffoKeyGap ? ['WAFFO_PRIVATE_KEY (or WAFFO_PRIVATE_KEY_BASE64)'] : [])].join(', ')} and redeploy.`
  }
  return null
}
