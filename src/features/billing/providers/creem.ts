/**
 * Creem adapter.
 *
 * Wraps the official `creem` SDK behind `PaymentProvider`. Route code never
 * imports the SDK directly.
 *
 * Two things worth knowing before editing:
 *   1. `CREEM_ENV` defaults to `test` (sandbox). A fresh dev env therefore
 *      cannot charge a real card even if the key is a live key.
 *   2. Creem never emits a stable customer id we can pre-create, so the local
 *      user is recovered from the `metadata.userId` we attached at checkout.
 */
import { Creem } from 'creem'
import type { DomainEvent } from '../entitlement'
import { asPlan, tierForProduct } from '../plans'
import type { CheckoutInput, PaymentProvider } from '../payment'
import { PROVIDER_CATALOG } from './catalog'
import { verifyCreemSignature } from './creem-signature'
import { readPolymorphicId } from './shared'

export interface CreemEnv {
  CREEM_API_KEY: string
  CREEM_WEBHOOK_SECRET: string
  /** `live` switches to the production API. Anything else (or unset) is test. */
  CREEM_ENV?: string
}

/** Map a raw Creem `eventType` to the platform's domain vocabulary. */
export function normalizeCreemEventType(raw: string): DomainEvent['type'] {
  switch (raw) {
    case 'checkout.completed':
      return 'purchase.completed'
    case 'refund.created':
    case 'refund.updated':
      return 'purchase.refunded'
    case 'subscription.active':
    case 'subscription.trialing':
    case 'subscription.paid':
    case 'subscription.update':
      return 'subscription.upserted'
    case 'subscription.scheduled_cancel':
    case 'subscription.paused':
      // Access continues until the paid period ends; the row records
      // cancelAtPeriodEnd rather than dropping to free.
      return 'subscription.upserted'
    case 'subscription.canceled':
    case 'subscription.expired':
      return 'subscription.deleted'
    case 'subscription.past_due':
    case 'subscription.unpaid':
      return 'payment.failed'
    case 'dispute.created':
    default:
      return 'ignored'
  }
}

/**
 * Creem's "this subscription is ending at period end" states. They arrive as
 * lifecycle events but must not revoke access yet.
 */
const CANCELING_STATUSES = new Set(['scheduled_cancel', 'paused'])
const TERMINAL_STATUSES = new Set(['canceled', 'expired', 'unpaid'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function createCreemProvider(env: CreemEnv): PaymentProvider {
  const meta = PROVIDER_CATALOG.creem
  const testMode = (env.CREEM_ENV ?? 'test') !== 'live'
  const client = new Creem({ apiKey: env.CREEM_API_KEY, serverIdx: testMode ? 1 : 0 })

  return {
    id: 'creem',
    displayName: meta.displayName,
    supportsPortal: meta.supportsPortal,
    cancelMode: meta.cancelMode,

    /** Creem has no customer-provisioning endpoint we can call before checkout;
     *  the customer is created by the SDK on checkout creation. */
    async ensureCustomer(_user, existingCustomerId) {
      return existingCustomerId
    },

    async createCheckoutSession(input: CheckoutInput) {
      const checkout = await client.checkouts.create({
        productId: input.productId,
        successUrl: input.successUrl,
        customer: { email: input.userEmail },
        metadata: input.metadata,
      })
      if (!checkout.checkoutUrl) throw new Error('Creem did not return a checkout URL')
      return { url: checkout.checkoutUrl }
    },

    async createPortalSession() {
      throw new Error('Creem has no customer portal — use cancelSubscription instead')
    },

    async parseWebhook(rawBody, headers): Promise<DomainEvent> {
      const signature = headers['creem-signature'] ?? null
      const ok = await verifyCreemSignature(rawBody, signature, env.CREEM_WEBHOOK_SECRET)
      if (!ok) throw new Error('Invalid Creem webhook signature')

      const payload = JSON.parse(rawBody) as Record<string, unknown>
      const object = isPlainObject(payload.object) ? payload.object : {}
      const eventId = typeof payload.id === 'string' ? payload.id : `creem_${crypto.randomUUID()}`
      const type = normalizeCreemEventType(typeof payload.eventType === 'string' ? payload.eventType : '')
      if (type === 'ignored') return { type: 'ignored', eventId }

      // The webhook envelope carries different object shapes per event type:
      // order events nest `object.order`, subscription events nest
      // `object.subscription`, and a raw checkout event *is* the object.
      const order = isPlainObject(object.order) ? object.order : null
      const subscription = isPlainObject(object.subscription) ? object.subscription : null
      const isCheckoutShaped = typeof object.id === 'string' && isPlainObject(object.metadata)
      const checkout = isCheckoutShaped ? object : null

      // Metadata precedence: the subscription's copy is the most specific, then
      // the checkout's. This is how a webhook with no ids of its own recovers
      // which local user paid.
      const metadata = (isPlainObject(subscription?.metadata) ? subscription.metadata
        : isPlainObject(checkout?.metadata) ? checkout.metadata
          : {}) as Record<string, unknown>

      const userId = typeof metadata.userId === 'string' ? metadata.userId : null
      const planId = typeof metadata.plan === 'string' ? metadata.plan : null
      const productId = readPolymorphicId(object.product)
        ?? (typeof metadata.productId === 'string' ? metadata.productId : null)
      const customerId = readPolymorphicId(object.customer)
      const subscriptionId = readPolymorphicId(subscription) ?? readPolymorphicId(order)
      const paymentRef = readPolymorphicId(order) ?? readPolymorphicId(checkout)
      const occurredAt = typeof payload.created_at === 'number' ? payload.created_at * 1000 : undefined
      const vendorStatus = typeof subscription?.status === 'string' ? subscription.status : 'active'

      // The plan comes from metadata when present (authored by us), otherwise
      // from resolving the product id against plans.ts — never from the
      // client's word alone.
      // Metadata is echoed back from what WE wrote at checkout, so it is a hint,
      // not authority: an unrecognised value falls through to the product-id
      // lookup, which is derived from plans.ts rather than from the wire.
      const plan = asPlan(planId) ?? tierForProduct('creem', productId)?.id ?? null

      const base = {
        eventId,
        providerId: 'creem' as const,
        userId,
        customerId,
      }

      if (type === 'purchase.completed') {
        return { ...base, type, plan: plan === 'free' ? 'pro' : plan, productId, paymentRef }
      }
      if (type === 'purchase.refunded') {
        return { ...base, type, paymentRef: readPolymorphicId(order) ?? paymentRef }
      }
      if (type === 'payment.failed') {
        return { ...base, type, occurredAt }
      }

      const isDeleting = type === 'subscription.deleted' || TERMINAL_STATUSES.has(vendorStatus)
      const status = CANCELING_STATUSES.has(vendorStatus)
        ? 'canceling'
        : isDeleting ? 'canceled' : vendorStatus

      return {
        ...base,
        type: isDeleting ? 'subscription.deleted' : 'subscription.upserted',
        subscriptionId: subscriptionId ?? eventId,
        status,
        plan,
        productId,
        currentPeriodEnd: typeof subscription?.current_period_end_date === 'string'
          ? Date.parse(subscription.current_period_end_date) || null
          : null,
        cancelAtPeriodEnd: CANCELING_STATUSES.has(vendorStatus),
        occurredAt,
      }
    },

    async cancelSubscription(subscriptionId) {
      // `scheduled` keeps access alive until the paid period ends, which is the
      // only honest cancel for a subscription the buyer already paid for.
      try {
        await client.subscriptions.cancel(subscriptionId, { mode: 'scheduled' })
      } catch (err) {
        // Idempotent for webhook retries / double-clicks.
        if (err instanceof Error && /not found|does not exist|already/i.test(err.message)) return
        throw err
      }
    },
  }
}
