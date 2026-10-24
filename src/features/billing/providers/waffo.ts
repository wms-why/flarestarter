/**
 * Waffo Pancake adapter.
 *
 * Wraps `@waffo/pancake-ts` behind `PaymentProvider`. Route code never imports
 * the SDK directly.
 *
 * Two hard requirements inherited from the vendor:
 *   1. `verifyWebhook` signs the **raw bytes**, so the route must read
 *      `request.text()` before anything parses the body.
 *   2. `WAFFO_WEBHOOK_PUBLIC_KEY` is mandatory. Without it the SDK falls back to
 *      its own bundled keypair, which we do not trust in production — so the
 *      registry hides Waffo entirely when it is missing, and this factory throws.
 *
 * Waffo uses `orderId` as the subscription identifier on subscription events and
 * echoes `orderMetadata` back on every related webhook — that metadata is how a
 * webhook with no customer id of ours recovers the paying user.
 */
import { WaffoPancake, type WebhookEvent, WebhookEventType, verifyWebhook } from '@waffo/pancake-ts'
import type { DomainEvent } from '../entitlement'
import { tierForProduct } from '../plans'
import { classifyPurchase } from '@/features/credits/credits.core'
import type { CheckoutInput, PaymentProvider } from '../payment'
import { PROVIDER_CATALOG } from './catalog'
import { toEpochMs } from './shared'

export interface WaffoEnv {
  WAFFO_MERCHANT_ID: string
  /** PEM, either literal newlines or `\n`-escaped for single-line env vars. */
  WAFFO_PRIVATE_KEY?: string
  /** CI-friendly alternative to `WAFFO_PRIVATE_KEY`. */
  WAFFO_PRIVATE_KEY_BASE64?: string
  WAFFO_WEBHOOK_PUBLIC_KEY: string
  /** `prod` selects the production signature key. Anything else is test. */
  WAFFO_ENV?: string
}

/** `atob` yields a binary string; round-trip through bytes for real UTF-8. */
export function base64ToUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/**
 * Resolve the PEM private key from whichever env var carries it. `*_BASE64`
 * wins when both are set — it survives copy-paste through shells and CI secret
 * stores that mangle literal newlines.
 */
export function resolvePrivateKey(env: WaffoEnv): string {
  if (env.WAFFO_PRIVATE_KEY_BASE64) {
    try {
      return base64ToUtf8(env.WAFFO_PRIVATE_KEY_BASE64)
    } catch {
      throw new Error('WAFFO_PRIVATE_KEY_BASE64 is not valid base64')
    }
  }
  if (!env.WAFFO_PRIVATE_KEY) throw new Error('Waffo provider not configured (missing WAFFO_PRIVATE_KEY)')
  return env.WAFFO_PRIVATE_KEY.replace(/\\n/g, '\n')
}

export function resolveWebhookPublicKey(env: WaffoEnv): string {
  if (!env.WAFFO_WEBHOOK_PUBLIC_KEY) {
    throw new Error('Waffo provider not configured (missing WAFFO_WEBHOOK_PUBLIC_KEY)')
  }
  return env.WAFFO_WEBHOOK_PUBLIC_KEY.replace(/\\n/g, '\n')
}

/** Map a raw Waffo event type to the platform's domain vocabulary. */
export function normalizeWaffoEventType(raw: string): DomainEvent['type'] {
  switch (raw) {
    case WebhookEventType.OrderCompleted:
      return 'purchase.completed'
    case WebhookEventType.RefundSucceeded:
      return 'purchase.refunded'
    case WebhookEventType.SubscriptionActivated:
    case WebhookEventType.SubscriptionPaymentSucceeded:
    case WebhookEventType.SubscriptionUncanceled:
    case WebhookEventType.SubscriptionUpdated:
      return 'subscription.upserted'
    case WebhookEventType.SubscriptionCanceling:
      // Still active until the paid period ends.
      return 'subscription.upserted'
    case WebhookEventType.SubscriptionCanceled:
      return 'subscription.deleted'
    case WebhookEventType.SubscriptionPastDue:
      return 'payment.failed'
    default:
      return 'ignored'
  }
}

const CANCELING_STATUSES = new Set(['canceling', 'cancel_at_period_end', 'pending_cancellation'])
const TERMINAL_STATUSES = new Set(['canceled', 'expired', 'failed', 'terminated'])

export function createWaffoProvider(env: WaffoEnv): PaymentProvider {
  const meta = PROVIDER_CATALOG.waffo
  const webhookPublicKey = resolveWebhookPublicKey(env)
  const environment = (env.WAFFO_ENV ?? 'test') as 'test' | 'prod'

  // Construct lazily: the registry asks each enabled provider for metadata
  // before anything is bought, and a malformed key must not break that.
  let cached: WaffoPancake | null = null
  const client = (): WaffoPancake => {
    if (!cached) {
      cached = new WaffoPancake({
        merchantId: env.WAFFO_MERCHANT_ID,
        privateKey: resolvePrivateKey(env),
        webhookPublicKey,
      })
    }
    return cached
  }

  return {
    id: 'waffo',
    displayName: meta.displayName,
    supportsPortal: meta.supportsPortal,
    cancelMode: meta.cancelMode,

    async ensureCustomer(_user, existingCustomerId) {
      return existingCustomerId
    },

    async createCheckoutSession(input: CheckoutInput) {
      const result = await client().checkout.createSession({
        productId: input.productId,
        // Waffo derives the real currency from the product created in its
        // dashboard; this placeholder only satisfies the SDK's required-currency
        // check and is never what the buyer is charged.
        currency: 'USD',
        buyerEmail: input.userEmail,
        successUrl: input.successUrl,
        metadata: input.metadata,
      })
      if (!result.checkoutUrl) throw new Error('Waffo did not return a checkout URL')
      return { url: result.checkoutUrl }
    },

    async createPortalSession() {
      throw new Error('Waffo has no customer portal — use cancelSubscription instead')
    },

    async parseWebhook(rawBody, headers): Promise<DomainEvent> {
      const signature = headers['x-waffo-signature'] ?? null
      if (!signature) throw new Error('Missing X-Waffo-Signature header')
      // Throws on bad signature, stale timestamp, or malformed header. The
      // public key is passed per-call so verification never falls back to the
      // SDK's bundled keypair.
      const event = verifyWebhook(rawBody, signature, { environment, publicKey: webhookPublicKey }) as WebhookEvent

      const eventId = event.id || event.eventId || `waffo_${crypto.randomUUID()}`
      const type = normalizeWaffoEventType(event.eventType)
      if (type === 'ignored') return { type: 'ignored', eventId }

      const data = (event.data ?? {}) as unknown as Record<string, unknown>
      const metadata = (data.orderMetadata ?? {}) as Record<string, string | undefined>
      const userId = metadata.userId ?? (typeof data.merchantProvidedBuyerIdentity === 'string' ? data.merchantProvidedBuyerIdentity : null)
      const productId = typeof data.productId === 'string' ? data.productId : null
      // Resolve the tier from the product id (plans.ts is the authority), not
      // from metadata.plan — the latter is echoed back from what we wrote at
      // checkout and must never be able to name a tier on its own.
      const plan = tierForProduct('waffo', productId)?.id ?? null

      const orderId = typeof data.orderId === 'string' ? data.orderId : eventId
      const orderStatus = typeof data.orderStatus === 'string' ? data.orderStatus : ''
      const occurredAt = toEpochMs(event.timestamp)
      const base = { eventId, providerId: 'waffo' as const, userId, customerId: null }

      if (type === 'purchase.completed') {
        // A product id that maps to a credit pack is a credit top-up, not a
        // lifetime grant — route it to the credits ledger instead.
        const classified = classifyPurchase('waffo', productId)
        if (classified.kind === 'credits') {
          return { eventId, providerId: 'waffo' as const, userId, type: 'credits.purchased', packId: classified.pack.id, paymentRef: orderId }
        }
        return { ...base, type, plan: plan === 'free' ? 'pro' : plan, productId, paymentRef: orderId }
      }
      if (type === 'purchase.refunded') {
        return { ...base, type, paymentRef: orderId }
      }
      if (type === 'payment.failed') {
        return { ...base, type, occurredAt }
      }

      const isDeleting = type === 'subscription.deleted' || TERMINAL_STATUSES.has(orderStatus)
      const status = CANCELING_STATUSES.has(orderStatus) ? 'canceling' : isDeleting ? 'canceled' : orderStatus || 'active'
      return {
        ...base,
        type: isDeleting ? 'subscription.deleted' : 'subscription.upserted',
        subscriptionId: orderId,
        status,
        plan,
        productId,
        currentPeriodEnd: toEpochMs(data.currentPeriodEnd as string | undefined) ?? null,
        cancelAtPeriodEnd: CANCELING_STATUSES.has(orderStatus),
        occurredAt,
      }
    },

    async cancelSubscription(subscriptionId) {
      try {
        await client().orders.cancelSubscription({ orderId: subscriptionId })
      } catch (err) {
        // Idempotent for webhook retries / double-clicks.
        if (err instanceof Error && /not found|does not exist|already/i.test(err.message)) return
        throw err
      }
    },
  }
}
