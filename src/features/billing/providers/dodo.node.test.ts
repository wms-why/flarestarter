import { describe, expect, test } from 'vitest'
import { createDodoProvider, normalizeDodoEventType, type DodoEnv } from '@/features/billing/providers/dodo'
import { creditPacks } from '@/features/credits/credit-packs'

const RAW_KEY = 'dodo-signing-key'
const ENV: DodoEnv = {
  DODO_PAYMENTS_API_KEY: 'dodo_test_1',
  DODO_PAYMENTS_WEBHOOK_KEY: `whsec_${btoa(RAW_KEY)}`,
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** Sign a delivery the way Dodo does (Standard Webhooks, HMAC over `id.timestamp.body`). */
async function headersFor(body: string, id = 'msg_1'): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(RAW_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${base64(new Uint8Array(mac))}` }
}

async function deliver(payload: unknown, env: DodoEnv = ENV, fetchImpl?: typeof fetch) {
  const body = JSON.stringify(payload)
  const headers = await headersFor(body)
  return createDodoProvider(env, fetchImpl).parseWebhook(body, headers)
}

/** A subscription payload shaped like Dodo's (`data` is the subscription object). */
function subscription(overrides: Record<string, unknown> = {}) {
  return {
    business_id: 'bus_1',
    type: 'subscription.active',
    timestamp: '2026-04-01T10:00:00Z',
    data: {
      payload_type: 'Subscription',
      subscription_id: 'sub_1',
      product_id: 'pdt_pro',
      status: 'active',
      customer: { customer_id: 'cus_1', email: 'buyer@example.com', name: 'Buyer' },
      metadata: { userId: 'u1', plan: 'pro' },
      next_billing_date: '2026-05-01T10:00:00Z',
      cancel_at_next_billing_date: false,
      currency: 'USD',
      ...overrides,
    },
  }
}

describe('normalizeDodoEventType', () => {
  test('payments and refunds', () => {
    expect(normalizeDodoEventType('payment.succeeded')).toBe('purchase.completed')
    expect(normalizeDodoEventType('payment.failed')).toBe('payment.failed')
    expect(normalizeDodoEventType('refund.succeeded')).toBe('purchase.refunded')
  })

  test('subscription lifecycle — grace and hold are not the same thing', () => {
    for (const type of ['subscription.active', 'subscription.renewed', 'subscription.updated', 'subscription.plan_changed', 'subscription.paused', 'subscription.unpaused', 'subscription.on_hold']) {
      expect(normalizeDodoEventType(type), type).toBe('subscription.upserted')
    }
    // past_due opens a grace period during which access continues.
    expect(normalizeDodoEventType('subscription.past_due')).toBe('payment.failed')
    for (const type of ['subscription.cancelled', 'subscription.expired', 'subscription.failed']) {
      expect(normalizeDodoEventType(type), type).toBe('subscription.deleted')
    }
  })

  test('everything that is not about entitlement collapses to ignored', () => {
    for (const type of ['payment.processing', 'payment.cancelled', 'dispute.opened', 'credit.added', 'license_key.created', 'payout.success', 'subscription.brand_new_thing']) {
      expect(normalizeDodoEventType(type), type).toBe('ignored')
    }
  })
})

describe('checkout', () => {
  function stubFetch(reply: { status?: number; body?: unknown; text?: string }) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
  }

  test('creates a hosted session through the test API and returns its url', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { session_id: 'cks_1', checkout_url: 'https://checkout.dodopayments.com/session/cks_1' } })
    const provider = createDodoProvider(ENV, fetchImpl)

    const out = await provider.createCheckoutSession({
      userId: 'u1',
      userEmail: 'buyer@example.com',
      customerId: 'cus_from_another_vendor',
      productId: 'pdt_pro',
      mode: 'subscription',
      successUrl: 'https://app.test/app?checkout=success',
      cancelUrl: 'https://app.test/checkout',
      metadata: { userId: 'u1', plan: 'pro', provider: 'dodo' },
    })

    expect(out).toEqual({ url: 'https://checkout.dodopayments.com/session/cks_1' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://test.dodopayments.com/checkouts')
    expect(calls[0].init.method).toBe('POST')
    const body = JSON.parse(String(calls[0].init.body))
    expect(body).toMatchObject({
      product_cart: [{ product_id: 'pdt_pro', quantity: 1 }],
      // The buyer is identified by email on purpose: a stored customer id may
      // belong to a different vendor.
      customer: { email: 'buyer@example.com' },
      return_url: 'https://app.test/app?checkout=success',
      cancel_url: 'https://app.test/checkout',
      metadata: { userId: 'u1', plan: 'pro', provider: 'dodo' },
    })
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer dodo_test_1')
  })

  test('DODO_ENV=live switches to the production API', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { checkout_url: 'https://checkout.dodopayments.com/x' } })
    await createDodoProvider({ ...ENV, DODO_ENV: 'live' }, fetchImpl).createCheckoutSession({
      userId: 'u1', userEmail: 'buyer@example.com', customerId: null, productId: 'pdt_pro',
      mode: 'subscription', successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no', metadata: {},
    })
    expect(calls[0].url).toBe('https://live.dodopayments.com/checkouts')
  })

  test('a response without a checkout url is an error, not a redirect to nowhere', async () => {
    const { fetchImpl } = stubFetch({ body: { session_id: 'cks_1' } })
    await expect(createDodoProvider(ENV, fetchImpl).createCheckoutSession({
      userId: 'u1', userEmail: 'buyer@example.com', customerId: null, productId: 'pdt_pro',
      mode: 'payment', successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no', metadata: {},
    })).rejects.toThrow(/checkout URL/)
  })

  test('a failed create surfaces the status and keeps the vendor body out of the error', async () => {
    const { fetchImpl } = stubFetch({ status: 422, text: '{"error":"PRODUCT_NOT_FOUND"}' })
    await expect(createDodoProvider(ENV, fetchImpl).createCheckoutSession({
      userId: 'u1', userEmail: 'buyer@example.com', customerId: null, productId: 'pdt_missing',
      mode: 'subscription', successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no', metadata: {},
    })).rejects.toThrow('Dodo Payments POST /checkouts failed (422)')
  })
})

describe('parseWebhook — signature', () => {
  test('rejects an unsigned delivery before reading any field', async () => {
    const body = JSON.stringify(subscription())
    await expect(createDodoProvider(ENV).parseWebhook(body, { 'webhook-id': 'msg_1' }))
      .rejects.toThrow(/signature/)
  })

  test('rejects a body replaced after signing', async () => {
    const original = JSON.stringify(subscription())
    const headers = await headersFor(original)
    await expect(createDodoProvider(ENV).parseWebhook(JSON.stringify(subscription({ status: 'cancelled' })), headers))
      .rejects.toThrow(/signature/)
  })
})

describe('parseWebhook — payments', () => {
  test('a one-time payment becomes purchase.completed, product id from the cart', async () => {
    const out = await deliver({
      business_id: 'bus_1',
      type: 'payment.succeeded',
      timestamp: '2026-04-01T10:00:00Z',
      data: {
        payload_type: 'Payment',
        payment_id: 'pay_1',
        status: 'succeeded',
        subscription_id: null,
        subscription_ids: [],
        product_cart: [{ product_id: 'pdt_lifetime', quantity: 1 }],
        customer: { customer_id: 'cus_1', email: 'buyer@example.com', name: 'Buyer' },
        metadata: { userId: 'u1', plan: 'pro', provider: 'dodo' },
      },
    })
    expect(out).toEqual({
      type: 'purchase.completed',
      eventId: 'msg_1',
      providerId: 'dodo',
      userId: 'u1',
      customerId: 'cus_1',
      // plan resolves from the metadata hint when plans.ts has no id for it.
      plan: 'pro',
      productId: 'pdt_lifetime',
      paymentRef: 'pay_1',
    })
  })

  test('a payment belonging to a subscription is ignored — it is an invoice, not a lifetime sale', async () => {
    // This is the trap: Dodo fires payment.succeeded for the first invoice of a
    // subscription. Treating it as a purchase would flip the row to `lifetime`.
    const out = await deliver({
      type: 'payment.succeeded',
      timestamp: '2026-04-01T10:00:00Z',
      data: {
        payload_type: 'Payment',
        payment_id: 'pay_1',
        status: 'succeeded',
        subscription_id: 'sub_1',
        product_cart: [{ product_id: 'pdt_pro', quantity: 1 }],
        metadata: { userId: 'u1' },
      },
    })
    expect(out).toEqual({ type: 'ignored', eventId: 'msg_1' })
  })

  test('multi-subscription carts (subscription_ids, no subscription_id) are invoices too', async () => {
    const out = await deliver({
      type: 'payment.succeeded',
      timestamp: '2026-04-01T10:00:00Z',
      data: { payment_id: 'pay_1', subscription_ids: ['sub_a', 'sub_b'], product_cart: [{ product_id: 'pdt_a' }] },
    })
    expect(out).toEqual({ type: 'ignored', eventId: 'msg_1' })
  })

  test('a product mapping to a credit pack routes to credits.purchased', async () => {
    const pack = creditPacks.find((p) => p.id === 'starter')!
    const original = pack.productIds.dodo
    pack.productIds.dodo = 'pdt_starter'
    try {
      const out = await deliver({
        type: 'payment.succeeded',
        timestamp: '2026-04-01T10:00:00Z',
        data: {
          payment_id: 'pay_credits',
          product_cart: [{ product_id: 'pdt_starter', quantity: 1 }],
          customer: { customer_id: 'cus_1', email: 'buyer@example.com' },
          metadata: { userId: 'u1' },
        },
      })
      expect(out).toEqual({
        type: 'credits.purchased',
        eventId: 'msg_1',
        providerId: 'dodo',
        userId: 'u1',
        packId: 'starter',
        paymentRef: 'pay_credits',
      })
    } finally {
      pack.productIds.dodo = original
    }
  })

  test('a refund is matched on the payment it refunds', async () => {
    const out = await deliver({
      type: 'refund.succeeded',
      timestamp: '2026-04-02T10:00:00Z',
      data: { payment_id: 'pay_1', refund_id: 'ref_1', status: 'succeeded', metadata: { userId: 'u1' } },
    })
    expect(out).toEqual({
      type: 'purchase.refunded',
      eventId: 'msg_1',
      providerId: 'dodo',
      userId: 'u1',
      customerId: null,
      paymentRef: 'pay_1',
    })
  })

  test('payment.failed carries the event time so the out-of-order guard can use it', async () => {
    const out = await deliver({
      type: 'payment.failed',
      timestamp: '2026-04-03T10:00:00Z',
      data: {
        payment_id: 'pay_2',
        status: 'failed',
        subscription_id: 'sub_1',
        customer: { customer_id: 'cus_1', email: 'buyer@example.com' },
        metadata: { userId: 'u1' },
      },
    })
    expect(out).toEqual({
      type: 'payment.failed',
      eventId: 'msg_1',
      providerId: 'dodo',
      userId: 'u1',
      customerId: 'cus_1',
      occurredAt: Date.parse('2026-04-03T10:00:00Z'),
    })
  })
})

describe('parseWebhook — subscriptions', () => {
  test('an active subscription upserts with its period end and resolved plan', async () => {
    const out = await deliver(subscription())
    expect(out).toMatchObject({
      type: 'subscription.upserted',
      eventId: 'msg_1',
      providerId: 'dodo',
      userId: 'u1',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      status: 'active',
      plan: 'pro',
      productId: 'pdt_pro',
      currentPeriodEnd: Date.parse('2026-05-01T10:00:00Z'),
      cancelAtPeriodEnd: false,
      occurredAt: Date.parse('2026-04-01T10:00:00Z'),
    })
  })

  test('a scheduled cancellation is `canceling`, not `cancelled` — access runs to period end', async () => {
    const out = await deliver(subscription({ cancel_at_next_billing_date: true }))
    expect(out).toMatchObject({ type: 'subscription.upserted', status: 'canceling', cancelAtPeriodEnd: true })
  })

  test('cancelled and expired end the subscription', async () => {
    for (const [type, status] of [['subscription.cancelled', 'cancelled'], ['subscription.expired', 'expired']] as const) {
      const out = await deliver(subscription({ type, status }))
      expect(out, type).toMatchObject({ type: 'subscription.deleted', subscriptionId: 'sub_1' })
    }
  })

  test('a cancellation reported via subscription.updated is a deletion too', async () => {
    const out = await deliver(subscription({ type: 'subscription.updated', status: 'cancelled' }))
    expect(out).toMatchObject({ type: 'subscription.deleted', subscriptionId: 'sub_1' })
  })

  test('past_due keeps access and raises the banner instead of revoking', async () => {
    const out = await deliver(subscription({ type: 'subscription.past_due', status: 'past_due' }))
    expect(out).toMatchObject({ type: 'payment.failed', userId: 'u1', customerId: 'cus_1' })
  })

  test('past_due arriving inside subscription.updated is treated the same way', async () => {
    const out = await deliver(subscription({ type: 'subscription.updated', status: 'past_due' }))
    expect(out).toMatchObject({ type: 'payment.failed' })
  })

  test('on_hold revokes, so it is written as a status', async () => {
    const out = await deliver(subscription({ type: 'subscription.on_hold', status: 'on_hold' }))
    expect(out).toMatchObject({ type: 'subscription.upserted', status: 'on_hold' })
  })

  test('a subscription without metadata still resolves its plan from plans.ts by product id', async () => {
    const out = await deliver(subscription({ metadata: {} }))
    // No product ids are configured in the shipped plans.ts, so the hint-free
    // lookup yields null rather than guessing a tier.
    expect(out).toMatchObject({ type: 'subscription.upserted', userId: null, plan: null, productId: 'pdt_pro' })
  })

  test('an unrelated event type short-circuits to ignored', async () => {
    expect(await deliver({ type: 'dispute.opened', timestamp: '2026-04-01T10:00:00Z', data: {} }))
      .toEqual({ type: 'ignored', eventId: 'msg_1' })
  })
})

describe('cancelSubscription', () => {
  function stub(status: number, text = '{}') {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(text, { status })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
  }

  test('schedules the cancellation at the next billing date', async () => {
    const { fetchImpl, calls } = stub(200)
    await createDodoProvider(ENV, fetchImpl).cancelSubscription('sub_1')
    expect(calls[0].url).toBe('https://test.dodopayments.com/subscriptions/sub_1')
    expect(calls[0].init.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ cancel_at_next_billing_date: true })
  })

  test('an already-cancelled subscription is not an error (webhook retries re-run this)', async () => {
    const { fetchImpl } = stub(404, '{"error":"SUBSCRIPTION_NOT_FOUND"}')
    await expect(createDodoProvider(ENV, fetchImpl).cancelSubscription('sub_1')).resolves.toBeUndefined()
  })

  test('a real failure throws so the route does not write a phantom `canceling` row', async () => {
    const { fetchImpl } = stub(500, 'boom')
    await expect(createDodoProvider(ENV, fetchImpl).cancelSubscription('sub_1')).rejects.toThrow(/cancel failed \(500\)/)
  })
})

/**
 * Payloads captured verbatim from a real Dodo test-mode delivery (Svix, 2026-11)
 * during an end-to-end run: hosted checkout → hosted card payment → webhook.
 *
 * They are here because the documented shapes and the wire disagree in ways that
 * matter — `subscription_id` *and* `subscription_ids` on a subscription invoice,
 * `product_cart: null` alongside `product_id: null`, `metadata: {}` on a refund.
 * Each assertion below is one of those details.
 */
describe('captured wire payloads', () => {
  test('a subscription invoice carries subscription_id and empty product_cart → ignored', async () => {
    const out = await deliver({
      business_id: 'bus_0Ns74zAaYeRTzQNTi6CPc',
      type: 'payment.succeeded',
      timestamp: '2026-11-17T03:00:42.000000Z',
      data: {
        payload_type: 'Payment',
        payment_id: 'pay_0Ns7BjrsnwbKym0yFjisi',
        status: 'succeeded',
        subscription_id: 'sub_0Ns7BjsDBP0d6EFmbmQ1F',
        subscription_ids: ['sub_0Ns7BjsDBP0d6EFmbmQ1F'],
        product_cart: null,
        product_id: null,
        customer: {
          customer_id: 'cus_0Ns7BjrRZtQf1GHbDunjG',
          email: 'e2e.dodo@example.com',
          name: 'E2E Dodo Tester',
          metadata: {},
          phone_number: null,
        },
        metadata: { plan: 'pro', provider: 'dodo', userId: 'u1' },
      },
    })
    expect(out).toEqual({ type: 'ignored', eventId: 'msg_1' })
  })

  test('a one-time pack payment has product_cart, no subscription ids, and credit-bearing metadata', async () => {
    const pack = creditPacks.find((p) => p.id === 'starter')!
    const original = pack.productIds.dodo
    pack.productIds.dodo = 'pdt_0Ns7Arx8z13yOsIwEPnzM'
    try {
      const out = await deliver({
        business_id: 'bus_0Ns74zAaYeRTzQNTi6CPc',
        type: 'payment.succeeded',
        timestamp: '2026-11-17T03:04:44.000000Z',
        data: {
          payload_type: 'Payment',
          payment_id: 'pay_0Ns7CVlp0N9a4BXMXbauC',
          status: 'succeeded',
          subscription_id: null,
          subscription_ids: [],
          product_cart: [{ product_id: 'pdt_0Ns7Arx8z13yOsIwEPnzM', quantity: 1 }],
          total_amount: 500,
          currency: 'USD',
          customer: { customer_id: 'cus_0Ns7BjrRZtQf1GHbDunjG', email: 'e2e.dodo@example.com', name: 'E2E Dodo Tester' },
          metadata: {
            kind: 'credits',
            packId: 'starter',
            productId: 'pdt_0Ns7Arx8z13yOsIwEPnzM',
            provider: 'dodo',
            userId: 'u1',
          },
        },
      })
      // Routing comes from product_cart, never from the `kind` hint we wrote.
      expect(out).toEqual({
        type: 'credits.purchased',
        eventId: 'msg_1',
        providerId: 'dodo',
        userId: 'u1',
        packId: 'starter',
        paymentRef: 'pay_0Ns7CVlp0N9a4BXMXbauC',
      })
    } finally {
      pack.productIds.dodo = original
    }
  })

  test('a refund arrives with empty metadata — matching must work off the payment id alone', async () => {
    const out = await deliver({
      business_id: 'bus_0Ns74zAaYeRTzQNTi6CPc',
      type: 'refund.succeeded',
      timestamp: '2026-11-17T03:05:06.000000Z',
      data: {
        payload_type: 'Refund',
        refund_id: 'ref_0Ns7Cfn5RSekLWvVTk8QM',
        payment_id: 'pay_0Ns7CVlp0N9a4BXMXbauC',
        amount: 500,
        currency: 'USD',
        status: 'succeeded',
        is_partial: false,
        metadata: {},
        customer: {
          customer_id: 'cus_0Ns7BjrRZtQf1GHbDunjG',
          name: 'E2E Dodo Tester',
          email: 'e2e.dodo@example.com',
          metadata: {},
          phone_number: null,
        },
      },
    })
    expect(out).toEqual({
      type: 'purchase.refunded',
      eventId: 'msg_1',
      providerId: 'dodo',
      // No userId on the refund envelope: the ledger row's own user_id is the
      // authority, which is why `purchase.refunded` is nullable here.
      userId: null,
      customerId: 'cus_0Ns7BjrRZtQf1GHbDunjG',
      paymentRef: 'pay_0Ns7CVlp0N9a4BXMXbauC',
    })
  })

  test('a live subscription event uses next_billing_date for the period end', async () => {
    const out = await deliver(subscription({
      subscription_id: 'sub_0Ns7BjsDBP0d6EFmbmQ1F',
      product_id: 'pdt_0Ns7ArkO0dSPrDPjKbi6w',
      next_billing_date: '2026-12-17T03:00:41.971635Z',
      customer: {
        customer_id: 'cus_0Ns7BjrRZtQf1GHbDunjG',
        email: 'e2e.dodo@example.com',
        name: 'E2E Dodo Tester',
        metadata: {},
        phone_number: null,
      },
    }))
    expect(out).toMatchObject({
      type: 'subscription.upserted',
      subscriptionId: 'sub_0Ns7BjsDBP0d6EFmbmQ1F',
      status: 'active',
      // Fractional seconds are part of the real value; `toEpochMs` must keep them.
      currentPeriodEnd: Date.parse('2026-12-17T03:00:41.971635Z'),
    })
  })
})
