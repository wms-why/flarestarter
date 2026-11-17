/**
 * Dodo Payments adapter.
 *
 * Plain `fetch`, no SDK — same trade-off as `paypal.ts`: the official client is
 * a full API surface (hundreds of endpoints) for the three calls we actually
 * make, and the REST shapes are documented and stable. Injecting `fetchImpl`
 * keeps it node-testable with no network.
 *
 * Four things shape this file:
 *
 *   1. **Signature verification is local.** Dodo signs with Standard Webhooks
 *      (HMAC-SHA256 over `id.timestamp.body`), which Workers' WebCrypto can
 *      check directly — unlike PayPal, no remote verdict is needed. See
 *      `dodo-signature.ts`.
 *   2. **There is no customer id we can pre-create.** `ensureCustomer` passes the
 *      stored id through untouched and checkout sends the buyer's *email*, so
 *      the local user is recovered from `metadata.userId` echoed back on every
 *      event — the same channel Creem uses.
 *   3. **`payment.succeeded` fires for subscription invoices too.** A payment
 *      carrying a `subscription_id` is the first (or nth) charge of a
 *      subscription, not a lifetime purchase. Treating it as one would flip the
 *      row to `lifetime` on the very first invoice, so it is ignored here and
 *      entitlement stays with the `subscription.*` events.
 *   4. **`past_due` is a grace state, not a revocation.** Dodo keeps access open
 *      while the grace period runs, so it is routed to the `payment.failed`
 *      channel (banner, plan untouched) instead of writing a non-entitling
 *      status. `on_hold` *does* revoke, and is written as a status.
 */
import { asPlan, tierForProduct } from '../plans'
import type { DomainEvent } from '../entitlement'
import { classifyPurchase } from '@/features/credits/credits.core'
import type { CheckoutInput, PaymentProvider } from '../payment'
import { PROVIDER_CATALOG } from './catalog'
import { verifyDodoSignature } from './dodo-signature'
import { toEpochMs } from './shared'

export interface DodoEnv {
  DODO_PAYMENTS_API_KEY: string
  /** The endpoint's signing secret (`whsec_…`) from Developer → Webhooks. */
  DODO_PAYMENTS_WEBHOOK_KEY: string
  /** `live` switches to the production API. Anything else (or unset) is test mode. */
  DODO_ENV?: string
}

/** Fetch injected for tests; defaults to the global. */
export type FetchLike = typeof fetch

function apiHost(env: DodoEnv): string {
  return (env.DODO_ENV ?? 'test') === 'live'
    ? 'https://live.dodopayments.com'
    : 'https://test.dodopayments.com'
}

/**
 * Dodo's subscription statuses that mean "this subscription is over".
 *
 * `failed` is here because it is terminal for that subscription (the initial
 * mandate never succeeded); `cancelled`/`expired` are the ordinary ends.
 */
const TERMINAL_STATUSES = new Set(['cancelled', 'canceled', 'failed', 'expired'])

/**
 * Map a raw Dodo event `type` to the platform's domain vocabulary.
 *
 * `subscription.updated` is deliberately an upsert: it is the only event that
 * carries a scheduled cancellation (`cancel_at_next_billing_date`) and plan
 * changes, and dropping it would leave the row stale.
 */
export function normalizeDodoEventType(raw: string): Exclude<DomainEvent['type'], 'credits.purchased'> {
  switch (raw) {
    case 'payment.succeeded':
      return 'purchase.completed'
    case 'payment.failed':
      return 'payment.failed'
    case 'refund.succeeded':
      return 'purchase.refunded'
    case 'subscription.active':
    case 'subscription.renewed':
    case 'subscription.updated':
    case 'subscription.plan_changed':
    case 'subscription.paused':
    case 'subscription.unpaused':
    case 'subscription.on_hold':
      return 'subscription.upserted'
    case 'subscription.past_due':
      // Grace period: access continues, so this is a "fix your card" signal,
      // not a revocation.
      return 'payment.failed'
    case 'subscription.cancelled':
    case 'subscription.expired':
    case 'subscription.failed':
      return 'subscription.deleted'
    default:
      // payment.processing / payment.cancelled / dispute.* / credit.* /
      // license_key.* / payout.* were never about entitlement.
      return 'ignored'
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function readId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** `data.customer` is an object on every payload; older/admin shapes may send a bare id. */
function readCustomerId(value: unknown): string | null {
  if (typeof value === 'string') return readId(value)
  if (isPlainObject(value)) return readId(value.customer_id)
  return null
}

/**
 * The product that was bought, from a *payment* payload.
 *
 * `product_cart` is populated for one-time payments and empty for subscription
 * invoices (Dodo FAQ Q61), which is exactly the distinction we need. The
 * `product_id` fallback covers payloads sent before that field existed.
 */
function paymentProductId(data: Record<string, unknown>): string | null {
  const cart = Array.isArray(data.product_cart) ? data.product_cart : []
  for (const item of cart) {
    if (!isPlainObject(item)) continue
    const id = readId(item.product_id)
    if (id) return id
  }
  return readId(data.product_id)
}

/** A payment that belongs to a subscription — i.e. an invoice, not a one-off sale. */
function belongsToSubscription(data: Record<string, unknown>): boolean {
  if (readId(data.subscription_id)) return true
  const ids = Array.isArray(data.subscription_ids) ? data.subscription_ids : []
  return ids.some((id) => readId(id) != null)
}

export function createDodoProvider(env: DodoEnv, fetchImpl: FetchLike = fetch): PaymentProvider {
  const meta = PROVIDER_CATALOG.dodo
  const host = apiHost(env)

  async function callApi(path: string, init: { method: string; body?: unknown }): Promise<Record<string, unknown>> {
    const res = await fetchImpl(`${host}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${env.DODO_PAYMENTS_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    if (!res.ok) {
      // The vendor's message is often the only actionable signal ("product not
      // found", "email invalid"), but it can leak internals — log the body,
      // surface only the status.
      const detail = await res.text().catch(() => '')
      console.error(`[billing] Dodo ${init.method} ${path} failed (${res.status}): ${detail.slice(0, 500)}`)
      throw new Error(`Dodo Payments ${init.method} ${path} failed (${res.status})`)
    }
    return (await res.json().catch(() => ({}))) as Record<string, unknown>
  }

  return {
    id: 'dodo',
    displayName: meta.displayName,
    supportsPortal: meta.supportsPortal,
    cancelMode: meta.cancelMode,

    /** Dodo can mint a customer at checkout, so there is nothing to pre-create. */
    async ensureCustomer(_user, existingCustomerId) {
      return existingCustomerId
    },

    async createCheckoutSession(input: CheckoutInput) {
      // One endpoint for both modes: the product's own type decides whether this
      // is a subscription or a one-time charge.
      //
      // The buyer is identified by **email**, never by `input.customerId`: that
      // column may hold an id minted by a *different* vendor (a user who
      // switched providers), and Dodo would 404 the session.
      const json = await callApi('/checkouts', {
        method: 'POST',
        body: {
          product_cart: [{ product_id: input.productId, quantity: 1 }],
          customer: { email: input.userEmail },
          return_url: input.successUrl,
          cancel_url: input.cancelUrl,
          metadata: input.metadata,
        },
      })
      const url = readId(json.checkout_url)
      if (!url) throw new Error('Dodo Payments did not return a checkout URL')
      return { url }
    },

    async createPortalSession() {
      throw new Error('Dodo Payments portal is not wired up in this template — use cancelSubscription instead')
    },

    async parseWebhook(rawBody, headers): Promise<DomainEvent> {
      const verified = await verifyDodoSignature({
        rawBody,
        headers,
        secret: env.DODO_PAYMENTS_WEBHOOK_KEY,
      })
      if (!verified) throw new Error('Invalid Dodo Payments webhook signature')

      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>
      } catch {
        throw new Error('Dodo Payments webhook body is not valid JSON')
      }

      // Standard Webhooks' `webhook-id` is the envelope's unique id — the
      // idempotency key the delivery is retried under.
      const eventId = readId(headers['webhook-id']) ?? `dodo_${crypto.randomUUID()}`
      const type = normalizeDodoEventType(typeof payload.type === 'string' ? payload.type : '')
      if (type === 'ignored') return { type: 'ignored', eventId }

      const data = isPlainObject(payload.data) ? payload.data : {}
      const occurredAt = toEpochMs(typeof payload.timestamp === 'string' ? payload.timestamp : null)
      const metadata = isPlainObject(data.metadata) ? data.metadata : {}
      const userId = readId(metadata.userId)
      const customerId = readCustomerId(data.customer)
      const base = { eventId, providerId: 'dodo' as const, userId, customerId }

      if (type === 'purchase.completed') {
        // An invoice for a subscription. Its entitlement belongs to the
        // `subscription.*` events; treating it as a one-time purchase here would
        // mark the row `lifetime` (and un-cancellable) on the first payment.
        if (belongsToSubscription(data)) return { type: 'ignored', eventId }

        const productId = paymentProductId(data)
        const paymentRef = readId(data.payment_id)
        // A product id that maps to a credit pack is a top-up, not a lifetime
        // grant — route it to the credits ledger instead.
        const classified = classifyPurchase('dodo', productId)
        if (classified.kind === 'credits') {
          return { eventId, providerId: 'dodo' as const, userId, type: 'credits.purchased', packId: classified.pack.id, paymentRef }
        }
        // Metadata is echoed back from what WE wrote at checkout, so it is a
        // hint, not authority: an unrecognised value falls through to the
        // product-id lookup, which is derived from plans.ts rather than the wire.
        const plan = asPlan(metadata.plan) ?? tierForProduct('dodo', productId)?.id ?? null
        return { ...base, type, plan: plan === 'free' ? 'pro' : plan, productId, paymentRef }
      }

      if (type === 'purchase.refunded') {
        return { ...base, type, paymentRef: readId(data.payment_id) }
      }

      if (type === 'payment.failed') {
        return { ...base, type, occurredAt }
      }

      // ---- subscription-shaped payload from here ----
      const vendorStatus = (typeof data.status === 'string' ? data.status : 'active').toLowerCase()
      const cancelAtNextBilling = data.cancel_at_next_billing_date === true
      const subscriptionId = readId(data.subscription_id) ?? eventId
      const productId = readId(data.product_id)
      const plan = asPlan(metadata.plan) ?? tierForProduct('dodo', productId)?.id ?? null

      if (type === 'subscription.deleted' || TERMINAL_STATUSES.has(vendorStatus)) {
        return { ...base, type: 'subscription.deleted', subscriptionId, occurredAt }
      }

      // A `subscription.updated` carrying `past_due` must not revoke access —
      // the grace period is still running. Same channel as the dedicated event.
      if (vendorStatus === 'past_due') return { ...base, type: 'payment.failed', occurredAt }

      return {
        ...base,
        type: 'subscription.upserted',
        subscriptionId,
        // `canceling` is the local vocabulary for "cancellation scheduled,
        // access runs to the end of the paid period" — the only cancel mode
        // this adapter offers (see cancelSubscription).
        status: cancelAtNextBilling && vendorStatus === 'active' ? 'canceling' : vendorStatus,
        plan,
        productId,
        currentPeriodEnd: toEpochMs(typeof data.next_billing_date === 'string' ? data.next_billing_date : null) ?? null,
        cancelAtPeriodEnd: cancelAtNextBilling,
        occurredAt,
      }
    },

    async cancelSubscription(subscriptionId) {
      // `cancel_at_next_billing_date` keeps access alive until the period the
      // buyer already paid for ends — the only honest cancel for a subscription.
      const res = await fetchImpl(`${host}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${env.DODO_PAYMENTS_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ cancel_at_next_billing_date: true }),
      })
      if (res.ok) return
      const detail = await res.text().catch(() => '')
      // Idempotent for webhook retries and double-clicks: an already-cancelled or
      // already-gone subscription is the desired end state, not an error.
      if (res.status === 404 || /already|not found|does not exist/i.test(detail)) return
      console.error(`[billing] Dodo cancel ${subscriptionId} failed (${res.status}): ${detail.slice(0, 500)}`)
      throw new Error(`Dodo Payments cancel failed (${res.status})`)
    },
  }
}
