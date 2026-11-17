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
 * Every provider is first-class: nothing in this file special-cases Stripe. The
 * two flags that *do* differ between vendors are capabilities, not a hierarchy:
 *
 *   - `supportsPortal` — Stripe, Dodo and Creem ship a hosted customer portal.
 *     All three mint the session per **customer**, so the adapter must have an
 *     id in hand: Dodo provisions it up front, Creem looks it up by email (it
 *     only creates the customer at checkout). Waffo and PayPal get an in-app
 *     cancel button driven by `cancelMode` instead: Waffo sells a management
 *     page through a different product line than the one we integrate, and
 *     PayPal has no such API at all. See each entry.
 *   - `cancelMode` — Stripe, Creem and Dodo cancel at period end; Waffo and
 *     PayPal cancel immediately (PayPal's API has no "cancel at period end"
 *     option). Callers must not assume cancellation is symmetric across
 *     vendors.
 */
export type ProviderId = 'stripe' | 'waffo' | 'creem' | 'paypal' | 'dodo'

export const PROVIDER_IDS: readonly ProviderId[] = ['stripe', 'waffo', 'creem', 'paypal', 'dodo']

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
    // "Immediate" is what we ask for (`orders.cancelSubscription` sends no
    // schedule), and Waffo's own /subscription/cancel agrees: an empty
    // `scheduledCancelAt` cancels now. Its `canceling` order status is the
    // window before the PSP confirms, and the row stays entitled through it —
    // this never revokes access early, and never after the vendor ends it,
    // because the terminal state only ever comes from the webhook.
    cancelMode: 'immediate',
    // Pancake — the product this adapter talks to (api.waffo.ai) — has no
    // management URL: its GraphQL surface is read-only (mutationType is null)
    // and its action list has no manage/portal action. Verified against the
    // live API, not just the SDK. Waffo does sell one, but through its separate
    // acquiring API (POST /api/v1/subscription/manage); Pancake merchant
    // credentials cannot reach that product, so it is not a wiring gap we could
    // close here. What Pancake does expose is
    // /v1/actions/subscription-order/reactivate-order — self-service we would
    // have to build a screen for, not a portal to redirect to.
    supportsPortal: false,
    // The private key may be supplied in two shapes (raw PEM or base64), so
    // `registry.ts` gates on "either one" rather than this list alone.
    requiredEnv: ['WAFFO_MERCHANT_ID', 'WAFFO_WEBHOOK_PUBLIC_KEY'],
  },
  creem: {
    displayName: 'Creem',
    logo: '/billing/creem_32x32.webp',
    cancelMode: 'at_period_end',
    // Hosted portal via POST /v1/customers/billing { customer_id } →
    // { customer_portal_link }. It is a magic-link page, so it cannot be themed
    // and the customer id must already exist (`ensureCustomer` resolves it).
    supportsPortal: true,
    requiredEnv: ['CREEM_API_KEY', 'CREEM_WEBHOOK_SECRET'],
  },
  paypal: {
    displayName: 'PayPal',
    logo: '/billing/paypal_32x32.webp',
    // No "cancel at period end" exists: /subscriptions/{id}/cancel ends it now.
    cancelMode: 'immediate',
    // Unlike Waffo there is nothing to reach even in principle: the v1 Billing
    // Subscriptions API has no operation that mints a payer-facing management
    // URL (create / get / patch / revise / suspend / cancel / activate /
    // capture / transactions). Buyers can only self-manage inside paypal.com,
    // which merchants cannot link to.
    supportsPortal: false,
    // No partial: without the webhook id PayPal can mint checkouts but cannot
    // durably record completions, so we treat that as "not configured".
    requiredEnv: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'],
  },
  dodo: {
    displayName: 'Dodo Payments',
    logo: '/billing/dodo_32x32.svg',
    // PATCH `cancel_at_next_billing_date` keeps the paid period intact.
    cancelMode: 'at_period_end',
    // Hosted portal via POST /customers/{id}/customer-portal/session. The id it
    // needs is provisioned in `ensureCustomer` and written back by the webhook.
    supportsPortal: true,
    // No partial: without the webhook key every delivery fails verification, so
    // a checkout that trusts it can never record a completion.
    requiredEnv: ['DODO_PAYMENTS_API_KEY', 'DODO_PAYMENTS_WEBHOOK_KEY'],
  },
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}
