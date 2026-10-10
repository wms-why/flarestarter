import type { DomainEvent } from './entitlement'
import type { ProviderId } from './providers/catalog'

export interface CheckoutInput {
  userId: string
  userEmail: string
  /** Provider-side customer id, when one exists. `null` for PayPal, which has none. */
  customerId: string | null
  /** Vendor product/plan id, resolved from `plans.ts` before we get here. */
  productId: string
  mode: 'subscription' | 'payment'
  successUrl: string
  cancelUrl: string
  /**
   * Merchant-side key/value round-tripped back on every related webhook.
   * This is how a webhook for Waffo/Creem/PayPal — none of which echo a
   * customer id we control — recovers which local user paid.
   */
  metadata: Record<string, string>
}

/**
 * The only contract route code ever sees. No vendor SDK leaks past this line.
 *
 * Adding a vendor is additive: implement this interface, add a case to
 * `providers/registry.ts`, and add the provider to `providers/catalog.ts`.
 *
 * **The adapters deliberately do NOT share a base class or an event-parsing
 * helper**, even though their `parseWebhook` bodies look alike. That similarity
 * is superficial — each encodes quirks specific to its vendor (Waffo's
 * `orderStatus` vocabulary and date-only period ends, Creem's polymorphic
 * `string | {id}` relations and `scheduled_cancel` state, PayPal's five-header
 * remote verification and its `P-` plan-id routing). A shared abstraction would
 * make every vendor's quirks a potential regression for the other three, which
 * is a bad trade at four providers. Re-raise this only if a fifth vendor
 * genuinely needs shared structure.
 */
export interface PaymentProvider {
  readonly id: ProviderId
  readonly displayName: string
  /** Only Stripe ships a hosted self-service billing portal. */
  readonly supportsPortal: boolean
  /** Whether cancelling ends access now or at the end of the paid period. */
  readonly cancelMode: 'immediate' | 'at_period_end'

  ensureCustomer(user: { id: string; email: string }, existingCustomerId: string | null): Promise<string | null>
  createCheckoutSession(input: CheckoutInput): Promise<{ url: string }>
  /** Throws when `supportsPortal` is false. */
  createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }>
  /**
   * Verify a delivery and normalize it into the platform's domain vocabulary.
   *
   * Takes the whole header bag rather than one signature string because PayPal
   * needs five `paypal-*` headers to verify — packing them into a JSON envelope
   * to fit a narrower signature would be a wart the route would have to know
   * about. Throws on bad signature / missing header / unverifiable delivery.
   *
   * Callers MUST pass the raw body verbatim: Waffo and Creem sign the exact
   * bytes, so any parse-then-reserialize before this call fails verification.
   */
  parseWebhook(rawBody: string, headers: Record<string, string | null>): Promise<DomainEvent>
  /** Immediately cancel a live subscription. MUST be idempotent: canceling an
   *  already-canceled/missing subscription resolves (webhook retries re-run it). */
  cancelSubscription(subscriptionId: string): Promise<void>
}

/** Normalize a request's headers into the shape `parseWebhook` expects. */
export function headerBag(headers: Headers): Record<string, string | null> {
  const bag: Record<string, string | null> = {}
  headers.forEach((value, key) => {
    bag[key.toLowerCase()] = value
  })
  return bag
}
