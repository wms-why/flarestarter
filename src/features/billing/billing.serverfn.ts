import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'
import type { Interval } from './plans'
import { PROVIDER_CATALOG, type ProviderId } from './providers/catalog'
import { buildOrderSummary, type OrderSummary } from './order-summary'
import { tierById, hasCheckout } from './plans'
import type { Locale } from '@/features/i18n/locale'
// Type-only imports are erased at compile time, so this never reaches the client
// bundle — unlike a value import of the registry itself.
import type { BillingEnv } from './providers/registry'

/**
 * Server functions backing the pricing and checkout routes.
 *
 * They exist as separate modules — rather than being inlined into the route
 * loaders — because a route file is compiled into *both* the client and server
 * bundles. Importing `providers/registry` (which reaches vendor SDKs and
 * `cloudflare:workers`) from a loader would drag all of that into the browser
 * bundle. Wrapping the work in `createServerFn(...).handler()` keeps the handler
 * body server-only, matching the repo's convention (see features/seo/seo.fns.ts).
 */

export interface CheckoutOptions {
  order: OrderSummary
  email: string
  providers: ProviderId[]
  preSelect?: ProviderId
  providerError?: string
  tierId: string
  interval: Interval
}

/**
 * Which providers `BILLING_PROVIDERS` has switched on — the pricing page's trust
 * strip. This is operator intent only; whether a provider is actually usable
 * is decided separately by `getCheckoutOptions`.
 */
export const getEnabledProviders = createServerFn({ method: 'GET' })
  .handler(async (): Promise<ProviderId[]> => {
    const { env } = await import('@/lib/env')
    const { parseEnabledProviders } = await import('./providers/registry')
    return parseEnabledProviders((env as unknown as BillingEnv).BILLING_PROVIDERS)
  })

/**
 * Everything the checkout page needs: the order summary plus the providers that
 * can actually sell this tier at this interval.
 *
 * The provider list here is the intersection of three things — the switch, the
 * vendor's secrets on this Worker, and a product id configured in plans.ts for
 * that exact (tier, interval) cell. `startCheckout` re-derives all of it before
 * creating a session, so this list only decides what to *render*.
 */
export const getCheckoutOptions = createServerFn({ method: 'GET' })
  .validator((d: { tier?: string; interval?: string; provider?: string; locale?: string }) => d)
  .handler(async ({ data }): Promise<CheckoutOptions | null> => {
    const { env } = await import('@/lib/env')
    const { availableProvidersForTier, resolvePurchase } = await import('./providers/registry')

    const locale: Locale = data.locale === 'zh' ? 'zh' : 'en'
    const interval: Interval = data.interval === 'yearly' ? 'yearly' : 'monthly'
    const tier = tierById(data.tier)
    const order = buildOrderSummary(data.tier, interval, locale)
    if (!tier || !order) return null

    const { readUser } = await import('@/features/auth/readUser.server')
    const user = await readUser()
    if (!user) throw redirect({ to: '/{-$locale}/login', params: { locale } })

    const billingEnv = env as unknown as BillingEnv
    // Same authority `startCheckout` uses, so a rendered button is a working
    // button — including the PayPal `P-` rule, which would otherwise draw a
    // button that always errors.
    const available = availableProvidersForTier(billingEnv, tier, interval)
      .filter((p) => resolvePurchase(billingEnv, tier, interval, p.id).ok)
      .map((p) => p.id)

    // `?provider=` is a deep-link convenience (shared checkout links). Honour it
    // only when it resolves; otherwise say exactly what is wrong rather than
    // silently offering a different vendor.
    let preSelect: ProviderId | undefined
    let providerError: string | undefined
    if (data.provider) {
      const asId = data.provider as ProviderId
      if (available.includes(asId)) {
        preSelect = asId
      } else if (PROVIDER_CATALOG[asId]) {
        providerError = resolvePurchase(billingEnv, tier, interval, asId).ok
          ? `Provider "${asId}" is not available for this plan.`
          : (resolvePurchase(billingEnv, tier, interval, asId) as { ok: false; reason: string }).reason
      }
    }

    return {
      order,
      email: user.email,
      providers: available,
      preSelect,
      providerError,
      tierId: tier.id,
      interval,
    }
  })

/**
 * Whether a tier/interval has any purchasable product configured at all — used
 * to send buyers away from a checkout page with nothing to buy.
 */
export const isPurchasable = createServerFn({ method: 'GET' })
  .validator((d: { tier?: string; interval?: string }) => d)
  .handler(async ({ data }): Promise<boolean> => {
    const tier = tierById(data.tier)
    if (!tier) return false
    return hasCheckout(tier, data.interval === 'yearly' ? 'yearly' : 'monthly')
  })
