/**
 * Static provider catalog.
 *
 * Pure data, zero dependencies, **client-importable**. The server-side registry
 * (`./registry.ts`) depends on env bindings + vendor SDKs and must never reach
 * the browser bundle; the pricing page however needs every provider's display
 * name and logo to render the "accepted payment methods" strip and (on the
 * checkout page) the provider buttons. So the static half of each provider's
 * description lives here, and the env/SDK half lives beside it.
 *
 * All four providers are first-class: nothing in this file special-cases
 * Stripe. The two flags that *do* differ between vendors are capabilities, not
 * a hierarchy:
 *
 *   - `supportsPortal` — only Stripe ships a hosted customer portal. The other
 *     three get an in-app cancel button driven by `cancelMode` instead.
 *   - `cancelMode` — Creem cancels at period end; Waffo and PayPal cancel
 *     immediately (PayPal's API has no "cancel at period end" option). Callers
 *     must not assume cancellation is symmetric across vendors.
 */
export type ProviderId = 'stripe' | 'waffo' | 'creem' | 'paypal'

export const PROVIDER_IDS: readonly ProviderId[] = ['stripe', 'waffo', 'creem', 'paypal']

export interface ProviderMeta {
  /** Human-readable name, shown on the trust strip and the checkout buttons. */
  displayName: string
  /** Public asset path (no cache-busting query), e.g. `/billing/stripe_32x32.svg`. */
  logo: string
  /** Whether cancelling takes effect at period end or right away. */
  cancelMode: 'immediate' | 'at_period_end'
  /** Whether this vendor offers a hosted self-service billing portal. */
  supportsPortal: boolean
  /**
   * Env vars that must ALL be non-empty for the provider to be considered
   * configured. Used by `registry.ts` for the secret-presence gate and by
   * `env-validate.ts` for startup warnings — both must stay in sync, which is
   * why the list lives here instead of being duplicated.
   */
  requiredEnv: readonly string[]
}

export const PROVIDER_CATALOG: Record<ProviderId, ProviderMeta> = {
  stripe: {
    displayName: 'Stripe',
    logo: '/billing/stripe_32x32.svg',
    cancelMode: 'at_period_end',
    supportsPortal: true,
    requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  },
  waffo: {
    displayName: 'Waffo Pancake',
    logo: '/billing/waffo_32x32.webp',
    cancelMode: 'immediate',
    supportsPortal: false,
    // The private key may be supplied in two shapes (raw PEM or base64), so
    // `registry.ts` gates on "either one" rather than this list alone.
    requiredEnv: ['WAFFO_MERCHANT_ID', 'WAFFO_WEBHOOK_PUBLIC_KEY'],
  },
  creem: {
    displayName: 'Creem',
    logo: '/billing/creem_32x32.webp',
    cancelMode: 'at_period_end',
    supportsPortal: false,
    requiredEnv: ['CREEM_API_KEY', 'CREEM_WEBHOOK_SECRET'],
  },
  paypal: {
    displayName: 'PayPal',
    logo: '/billing/paypal_32x32.webp',
    cancelMode: 'immediate',
    supportsPortal: false,
    // No partial: without the webhook id PayPal can mint checkouts but cannot
    // durably record completions, so we treat that as "not configured".
    requiredEnv: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'],
  },
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}
