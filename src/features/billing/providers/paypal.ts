/**
 * PayPal adapter.
 *
 * Plain `fetch`, deliberately no SDK: both official PayPal SDKs pull Node's
 * `http`/`https`/`stream`, which do not exist in the Workers runtime.
 *
 * Three things that shape this file:
 *   1. **Signature verification is remote.** PayPal signs RSA-SHA256 over a
 *      message we cannot reconstruct without the cert chain, and Workers has no
 *      `crypto.createVerify`. So we forward the delivery to PayPal's own
 *      `verify-webhook-signature` endpoint and trust its verdict.
 *   2. **There is no customer id.** PayPal's subscription/order APIs never hand
 *      back a stable customer identifier we could have pre-created, so the local
 *      user is recovered from `custom_id`, which we set at checkout time.
 *   3. **Tokens are minted per call, not cached.** They last ~9 hours, but a
 *      Worker isolate is short-lived and stateless, so the extra round trip is
 *      cheaper than a KV/Durable Object cache that would have to be correct.
 */
import { tierForProduct } from '../plans'
import type { DomainEvent } from '../entitlement'
import { APP_NAME } from '@/lib/brand'
import { classifyPurchase } from '@/features/credits/credits.core'
import type { CheckoutInput, PaymentProvider } from '../payment'
import { PROVIDER_CATALOG } from './catalog'
import { toEpochMs } from './shared'

export interface PaypalEnv {
  PAYPAL_CLIENT_ID: string
  PAYPAL_CLIENT_SECRET: string
  /** `WH-…` id of the webhook registered in the PayPal dashboard. */
  PAYPAL_WEBHOOK_ID: string
  /** `live` switches to production endpoints. Anything else (or unset) is sandbox. */
  PAYPAL_ENV?: string
}

function apiHost(env: PaypalEnv): string {
  return (env.PAYPAL_ENV ?? 'sandbox') === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com'
}

/** Fetch injected for tests; defaults to the global. */
export type FetchLike = typeof fetch

async function mintAccessToken(env: PaypalEnv, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(`${apiHost(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error(`PayPal OAuth token mint failed (${res.status})`)
  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) throw new Error('PayPal OAuth response missing access_token')
  return json.access_token
}

/** Map a raw PayPal `event_type` to the platform's domain vocabulary. */
export function normalizePaypalEventType(raw: string): Exclude<DomainEvent['type'], 'credits.purchased'> {
  switch (raw) {
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.SALE.COMPLETED':
      return 'purchase.completed'
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED':
    case 'PAYMENT.SALE.REFUNDED':
    case 'PAYMENT.SALE.REVERSED':
      return 'purchase.refunded'
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
    case 'BILLING.SUBSCRIPTION.RENEWED':
      return 'subscription.upserted'
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
      return 'subscription.deleted'
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
      return 'payment.failed'
    default:
      return 'ignored'
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** PayPal signals the next charge date; that is what the UI renders as "renews on". */
function nextBillingTime(resource: Record<string, unknown>): number | null {
  const billingInfo = isPlainObject(resource.billing_info) ? resource.billing_info : null
  return toEpochMs(typeof billingInfo?.next_billing_time === 'string' ? billingInfo.next_billing_time : null) ?? null
}

/**
 * Local subscription status for a PayPal lifecycle event.
 *
 * PayPal's `resource.status` is present on most lifecycle events but absent on
 * `ACTIVATED`/`RE-ACTIVATED`, so the event type is the backstop. Getting this
 * wrong is not cosmetic: `applyDomainEvent` grants or revokes paid access based
 * on it, so a hardcoded value here would either never grant or instantly revoke.
 */
function paypalSubscriptionStatus(eventType: string, resource: Record<string, unknown>): string {
  switch (eventType) {
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
      return 'canceled'
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
    case 'BILLING.SUBSCRIPTION.RENEWED':
      return 'active'
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
      return 'past_due'
    default:
      return typeof resource.status === 'string' ? resource.status.toLowerCase() : 'active'
  }
}

/**
 * The plan id is either the PayPal plan (`P-…`) or, for one-time orders, the
 * product id. `plans.ts` documents the `P-` requirement; the caller validates it
 * so a misconfigured id fails loudly instead of silently becoming a $0 order.
 */
export function isSubscriptionPlanId(productId: string): boolean {
  return productId.startsWith('P-')
}

export function createPaypalProvider(env: PaypalEnv, fetchImpl: FetchLike = fetch): PaymentProvider {
  const meta = PROVIDER_CATALOG.paypal
  const host = apiHost(env)

  /** PayPal returns the buyer's next step as a link; find the one to send them to. */
  const approveLink = (links: unknown): string | null => {
    if (!Array.isArray(links)) return null
    for (const link of links) {
      if (isPlainObject(link) && (link.rel === 'approve' || link.rel === 'approval_url') && typeof link.href === 'string') {
        return link.href
      }
    }
    return null
  }

  return {
    id: 'paypal',
    displayName: meta.displayName,
    supportsPortal: meta.supportsPortal,
    cancelMode: meta.cancelMode,

    async ensureCustomer(_user, existingCustomerId) {
      return existingCustomerId
    },

    async createCheckoutSession(input: CheckoutInput) {
      const token = await mintAccessToken(env, fetchImpl)
      const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Idempotency for the create call: a retried request returns the same
        // order/subscription instead of minting a second one.
        'PayPal-Request-Id': crypto.randomUUID(),
      }

      if (isSubscriptionPlanId(input.productId)) {
        const res = await fetchImpl(`${host}/v1/billing/subscriptions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            plan_id: input.productId,
            subscriber: { email_address: input.userEmail },
            application_context: {
              brand_name: APP_NAME,
              user_action: 'SUBSCRIBE_NOW',
              return_url: input.successUrl,
              // Deriving the cancel URL by rewriting the success URL keeps the
              // two in sync, but depends on `status=success` being present —
              // callers must include it.
              cancel_url: input.cancelUrl,
            },
            custom_id: input.metadata.userId,
          }),
        })
        if (!res.ok) throw new Error(`PayPal create-subscription failed (${res.status})`)
        const json = (await res.json()) as { id?: string; links?: unknown }
        const url = approveLink(json.links)
        if (!json.id || !url) throw new Error('PayPal create-subscription response missing id or approve link')
        return { url }
      }

      const res = await fetchImpl(`${host}/v2/checkout/orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            reference_id: input.productId,
            custom_id: input.metadata.userId,
          }],
          payment_source: {
            paypal: {
              email_address: input.userEmail,
              experience_context: {
                brand_name: APP_NAME,
                user_action: 'PAY_NOW',
                return_url: input.successUrl,
                cancel_url: input.cancelUrl,
              },
            },
          },
        }),
      })
      if (!res.ok) throw new Error(`PayPal create-order failed (${res.status})`)
      const json = (await res.json()) as { id?: string; links?: unknown }
      const url = approveLink(json.links)
      if (!json.id || !url) throw new Error('PayPal create-order response missing id or approve link')
      return { url }
    },

    async createPortalSession() {
      throw new Error('PayPal has no customer portal — use cancelSubscription instead')
    },

    async parseWebhook(rawBody, headers): Promise<DomainEvent> {
      const envelope = {
        authAlgo: headers['paypal-auth-algo'],
        certUrl: headers['paypal-cert-url'],
        transmissionId: headers['paypal-transmission-id'],
        transmissionSig: headers['paypal-transmission-sig'],
        transmissionTime: headers['paypal-transmission-time'],
      }
      const missing = Object.entries(envelope).filter(([, v]) => !v).map(([k]) => k)
      if (missing.length) throw new Error(`Incomplete PayPal signature headers (missing ${missing.join(', ')})`)

      let parsed: { id?: string; event_type?: string; create_time?: string; resource?: unknown }
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        throw new Error('PayPal webhook body is not valid JSON')
      }

      const token = await mintAccessToken(env, fetchImpl)
      const res = await fetchImpl(`${host}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          auth_algo: envelope.authAlgo,
          cert_url: envelope.certUrl,
          transmission_id: envelope.transmissionId,
          transmission_sig: envelope.transmissionSig,
          transmission_time: envelope.transmissionTime,
          webhook_id: env.PAYPAL_WEBHOOK_ID,
          // PayPal verifies against the parsed event, so this is the one case
          // where parsing *before* verification is required.
          webhook_event: parsed,
        }),
      })
      if (!res.ok) {
        // A 5xx here is PayPal's problem, not a bad signature — the route maps
        // this to 502 so PayPal retries instead of us discarding a real event.
        throw new Error(`PayPal verify-webhook-signature call failed (${res.status})`)
      }
      const verdict = (await res.json()) as { verification_status?: string }
      if (verdict.verification_status !== 'SUCCESS') throw new Error('PayPal webhook signature verification failed')

      const eventId = typeof parsed.id === 'string' && parsed.id ? parsed.id : `paypal_${crypto.randomUUID()}`
      const eventType = parsed.event_type ?? ''
      const type = normalizePaypalEventType(eventType)
      if (type === 'ignored') return { type: 'ignored', eventId }

      const resource = isPlainObject(parsed.resource) ? parsed.resource : {}
      const isSubscriptionEvent = eventType.startsWith('BILLING.SUBSCRIPTION.')
      const supplementary = isPlainObject(resource.supplementary_data) ? resource.supplementary_data : null
      const relatedIds = isPlainObject(supplementary?.related_ids) ? supplementary.related_ids : {}

      const userId = typeof resource.custom_id === 'string' ? resource.custom_id : null
      const productId = typeof resource.plan_id === 'string'
        ? resource.plan_id
        : typeof resource.purchase_units === 'object' && resource.purchase_units
          ? readPurchaseUnitReferenceId(resource.purchase_units)
          : null
      const plan = tierForProduct('paypal', productId)?.id ?? null
      const subscriptionId = isSubscriptionEvent
        ? (typeof resource.id === 'string' ? resource.id : null)
        : (typeof resource.billing_agreement_id === 'string' ? resource.billing_agreement_id : null)
      const orderId = isSubscriptionEvent
        ? subscriptionId
        : (typeof relatedIds.order_id === 'string' ? relatedIds.order_id
          : typeof resource.id === 'string' ? resource.id : null)
      const occurredAt = toEpochMs(parsed.create_time)

      // PayPal never gives us a customer id to store, so userId is the only
      // handle. Events without one cannot be attributed and are ignored below.
      if (!userId) return { type: 'ignored', eventId }

      const base = { eventId, providerId: 'paypal' as const, userId, customerId: null }

      if (type === 'purchase.completed') {
        // A product id that maps to a credit pack is a credit top-up, not a
        // lifetime grant — route it to the credits ledger instead.
        const classified = classifyPurchase('paypal', productId)
        if (classified.kind === 'credits') {
          return { eventId, providerId: 'paypal' as const, userId, type: 'credits.purchased', packId: classified.pack.id, paymentRef: orderId }
        }
        return { ...base, type, plan: plan === 'free' ? 'pro' : plan, productId, paymentRef: orderId }
      }
      if (type === 'purchase.refunded') {
        return { ...base, type, paymentRef: orderId }
      }
      if (type === 'payment.failed') {
        return { ...base, type, occurredAt }
      }
      return {
        ...base,
        type,
        subscriptionId: subscriptionId ?? eventId,
        status: paypalSubscriptionStatus(eventType, resource),
        plan,
        productId,
        currentPeriodEnd: nextBillingTime(resource),
        cancelAtPeriodEnd: false,
        occurredAt,
      }
    },

    async cancelSubscription(subscriptionId) {
      const token = await mintAccessToken(env, fetchImpl)
      const res = await fetchImpl(`${host}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ reason: 'Cancelled by user from the account page' }),
      })
      // 204 is the documented success. Anything else — including "already
      // cancelled" — is a real failure worth surfacing, but an unknown/already
      // gone subscription must stay idempotent for webhook retries.
      if (res.ok) return
      if (res.status === 404 || res.status === 409) return
      throw new Error(`PayPal cancel-subscription failed (${res.status})`)
    },
  }
}

/** `purchase_units[0].reference_id` — where we stashed the product id. */
function readPurchaseUnitReferenceId(purchaseUnits: unknown): string | null {
  if (!Array.isArray(purchaseUnits) || purchaseUnits.length === 0) return null
  const first = purchaseUnits[0]
  if (!isPlainObject(first)) return null
  return typeof first.reference_id === 'string' ? first.reference_id : null
}
