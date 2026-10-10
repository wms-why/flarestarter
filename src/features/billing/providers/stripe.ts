import Stripe from 'stripe'
import { translateStripeEvent, type DomainEvent } from '../entitlement'
import type { PaymentProvider, CheckoutInput } from '../payment'
import { PROVIDER_CATALOG } from './catalog'

export interface StripeEnv { STRIPE_SECRET_KEY: string; STRIPE_WEBHOOK_SECRET: string }


export function createStripeProvider(env: StripeEnv): PaymentProvider {
  const meta = PROVIDER_CATALOG.stripe
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() })
  const cryptoProvider = Stripe.createSubtleCryptoProvider()

  return {
    id: 'stripe',
    displayName: meta.displayName,
    supportsPortal: meta.supportsPortal,
    cancelMode: meta.cancelMode,

    async ensureCustomer(user, existingCustomerId) {
      if (existingCustomerId) return existingCustomerId
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } })
      return customer.id
    },
    async createCheckoutSession(input: CheckoutInput) {
      const session = await stripe.checkout.sessions.create({
        mode: input.mode,
        customer: input.customerId ?? undefined,
        line_items: [{ price: input.productId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        // Round-trips onto checkout.session.completed, which is how a one-time
        // purchase is attributed to a local user — the subscription events carry
        // no reference back to us.
        client_reference_id: input.userId,
        metadata: input.metadata,
      })
      if (!session.url) throw new Error('Stripe did not return a checkout URL')
      return { url: session.url }
    },
    async createPortalSession(customerId, returnUrl) {
      const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl })
      return { url: session.url }
    },
    // Stripe verifies off a single header, so the wider `headers` bag is unused
    // here — but every adapter takes the same shape, so routes stay uniform.
    async parseWebhook(rawBody, headers): Promise<DomainEvent> {
      const event = await stripe.webhooks.constructEventAsync(rawBody, headers['stripe-signature'] ?? '', env.STRIPE_WEBHOOK_SECRET, undefined, cryptoProvider)
      return translateStripeEvent(event)
    },
    async cancelSubscription(subscriptionId) {
      try {
        await stripe.subscriptions.cancel(subscriptionId)
      } catch (err) {
        // Idempotency: a webhook retry after a partial failure may hit a sub
        // that is already canceled or gone — both mean "done", not an error.
        if (err instanceof Stripe.errors.StripeInvalidRequestError &&
            (err.code === 'resource_missing' || /canceled/i.test(err.message))) return
        throw err
      }
    },
  }
}
