import { describe, expect, test } from 'vitest'
import { createCreemProvider, normalizeCreemEventType, type CreemEnv } from '@/features/billing/providers/creem'
import { readPolymorphicId, toEpochMs } from '@/features/billing/providers/shared'
import { creditPacks } from '@/features/credits/credit-packs'

const ENV: CreemEnv = {
  CREEM_API_KEY: 'creem_test_1',
  CREEM_WEBHOOK_SECRET: 'whsec_creem',
}

async function sign(body: string, secret = ENV.CREEM_WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function deliver(payload: unknown, secret?: string) {
  const body = JSON.stringify(payload)
  const signature = await sign(body, secret)
  return createCreemProvider(ENV).parseWebhook(body, { 'creem-signature': signature })
}

describe('normalizeCreemEventType', () => {
  test('order and refund', () => {
    expect(normalizeCreemEventType('checkout.completed')).toBe('purchase.completed')
    expect(normalizeCreemEventType('refund.created')).toBe('purchase.refunded')
  })

  test('subscription lifecycle — canceling states stay upserts, not deletions', () => {
    expect(normalizeCreemEventType('subscription.active')).toBe('subscription.upserted')
    expect(normalizeCreemEventType('subscription.trialing')).toBe('subscription.upserted')
    expect(normalizeCreemEventType('subscription.paid')).toBe('subscription.upserted')
    expect(normalizeCreemEventType('subscription.scheduled_cancel')).toBe('subscription.upserted')
    expect(normalizeCreemEventType('subscription.paused')).toBe('subscription.upserted')
    expect(normalizeCreemEventType('subscription.canceled')).toBe('subscription.deleted')
    expect(normalizeCreemEventType('subscription.expired')).toBe('subscription.deleted')
    expect(normalizeCreemEventType('subscription.past_due')).toBe('payment.failed')
  })

  test('disputes and unknown types collapse to ignored', () => {
    expect(normalizeCreemEventType('dispute.created')).toBe('ignored')
    expect(normalizeCreemEventType('subscription.brand_new_thing')).toBe('ignored')
  })
})

describe('shared helpers', () => {
  test('toEpochMs accepts the three date shapes vendors use', () => {
    // Waffo date-only → UTC midnight so the rendered date matches the buyer's calendar.
    expect(toEpochMs('2026-05-01')).toBe(Date.parse('2026-05-01T00:00:00Z'))
    // PayPal full ISO with offset.
    expect(toEpochMs('2026-05-01T07:00:00Z')).toBe(Date.parse('2026-05-01T07:00:00Z'))
    // Already a number (Creem).
    expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000)
  })

  test('toEpochMs rejects anything that is not ISO rather than trusting Date.parse', () => {
    // V8 reads "May 1 2026" just fine, but a loose parse of a renewal date is
    // worse than no date at all.
    expect(toEpochMs('May 1 2026')).toBeUndefined()
    expect(toEpochMs('01/05/2026')).toBeUndefined()
    expect(toEpochMs('   ')).toBeUndefined()
    expect(toEpochMs('')).toBeUndefined()
    expect(toEpochMs(null)).toBeUndefined()
    expect(toEpochMs(Number.NaN)).toBeUndefined()
  })

  test('toEpochMs still accepts ISO timestamps with and without a zone', () => {
    expect(toEpochMs('2026-05-01T10:30:00Z')).toBe(Date.parse('2026-05-01T10:30:00Z'))
    expect(toEpochMs('2026-05-01T10:30:00+02:00')).toBe(Date.parse('2026-05-01T10:30:00+02:00'))
  })

  test('readPolymorphicId handles both the expanded-object and bare-id shapes', () => {
    expect(readPolymorphicId('sub_1')).toBe('sub_1')
    expect(readPolymorphicId({ id: 'sub_1' })).toBe('sub_1')
    expect(readPolymorphicId({ id: 7 })).toBeNull()
    expect(readPolymorphicId(null)).toBeNull()
    expect(readPolymorphicId(['a'])).toBeNull()
  })

})

describe('parseWebhook — signature gate', () => {
  test('rejects a body signed with the wrong secret', async () => {
    const body = JSON.stringify({ id: 'evt_1', eventType: 'checkout.completed', object: {} })
    const signature = await sign(body, 'wrong-secret')
    await expect(createCreemProvider(ENV).parseWebhook(body, { 'creem-signature': signature }))
      .rejects.toThrow(/Invalid Creem webhook signature/)
  })

  test('rejects a missing signature header', async () => {
    const body = JSON.stringify({ id: 'evt_1', eventType: 'checkout.completed', object: {} })
    await expect(createCreemProvider(ENV).parseWebhook(body, {})).rejects.toThrow(/Invalid Creem webhook signature/)
  })
})

describe('parseWebhook — attribution', () => {
  test('recovers userId from checkout metadata on a completed order', async () => {
    const out = await deliver({
      id: 'evt_1',
      eventType: 'checkout.completed',
      created_at: 1_700_000_000,
      object: { id: 'chk_1', metadata: { userId: 'u1', plan: 'pro' }, customer: { id: 'cus_9', email_address: 'a@b.c' } },
    })
    expect(out).toEqual({
      type: 'purchase.completed',
      eventId: 'evt_1',
      providerId: 'creem',
      userId: 'u1',
      customerId: 'cus_9',
      plan: 'pro',
      productId: null,
      paymentRef: 'chk_1',
    })
  })

  test('subscription metadata wins over checkout metadata when both are present', async () => {
    const out = await deliver({
      id: 'evt_2',
      eventType: 'subscription.active',
      created_at: 1_700_000_001,
      object: {
        subscription: { id: 'sub_1', status: 'active', metadata: { userId: 'u-sub' }, current_period_end_date: '2026-06-01T00:00:00Z' },
        checkout: { metadata: { userId: 'u-checkout' } },
        product: { id: 'prod_1' },
      },
    })
    expect(out).toMatchObject({
      type: 'subscription.upserted',
      userId: 'u-sub',
      subscriptionId: 'sub_1',
      status: 'active',
      currentPeriodEnd: Date.parse('2026-06-01T00:00:00Z'),
    })
  })

  test('an unknown metadata plan is ignored rather than trusted', async () => {
    const out = await deliver({
      id: 'evt_3',
      eventType: 'checkout.completed',
      object: { id: 'chk_1', metadata: { userId: 'u1', plan: 'platinum' } },
    })
    expect(out).toMatchObject({ type: 'purchase.completed', plan: null })
  })

  test('an event with no metadata at all is still normalized, with no attribution', async () => {
    const out = await deliver({ id: 'evt_4', eventType: 'checkout.completed', object: {} })
    expect(out).toMatchObject({ type: 'purchase.completed', userId: null, customerId: null })
  })

  test('an event with no id gets a synthetic one so idempotency still has a key', async () => {
    const out = await deliver({ eventType: 'checkout.completed', object: {} })
    expect(out.eventId).toMatch(/^creem_/)
  })
})

describe('parseWebhook — status mapping', () => {
  test('scheduled_cancel keeps access and flags period-end cancellation', async () => {
    const out = await deliver({
      id: 'evt_5',
      eventType: 'subscription.scheduled_cancel',
      object: { subscription: { id: 'sub_1', status: 'scheduled_cancel', metadata: { userId: 'u1' } } },
    })
    expect(out).toMatchObject({ type: 'subscription.upserted', status: 'canceling', cancelAtPeriodEnd: true })
  })

  test('expired becomes a deletion even though the event type was an upsert', async () => {
    const out = await deliver({
      id: 'evt_6',
      eventType: 'subscription.expired',
      object: { subscription: { id: 'sub_1', status: 'expired', metadata: { userId: 'u1' } } },
    })
    expect(out).toMatchObject({ type: 'subscription.deleted', status: 'canceled' })
  })

  test('unpaid maps to payment.failed, not a cancellation', async () => {
    const out = await deliver({
      id: 'evt_7',
      eventType: 'subscription.unpaid',
      created_at: 1_700_000_002,
      object: { subscription: { id: 'sub_1', metadata: { userId: 'u1' } } },
    })
    expect(out).toEqual({ type: 'payment.failed', eventId: 'evt_7', providerId: 'creem', userId: 'u1', customerId: null, occurredAt: 1_700_000_002_000 })
  })

  test('a refund carries the order id for exact matching', async () => {
    const out = await deliver({
      id: 'evt_8',
      eventType: 'refund.created',
      object: { order: { id: 'ord_1' }, metadata: { userId: 'u1' } },
    })
    expect(out).toMatchObject({ type: 'purchase.refunded', paymentRef: 'ord_1' })
  })

  test('a checkout whose product maps to a credit pack routes to credits.purchased', async () => {
    const pack = creditPacks.find((p) => p.id === 'starter')!
    const original = pack.productIds.creem
    pack.productIds.creem = 'prod_starter'
    try {
      const out = await deliver({
        id: 'evt_credits',
        eventType: 'checkout.completed',
        object: { id: 'chk_credits', product: { id: 'prod_starter' }, metadata: { userId: 'u1' } },
      })
      expect(out).toEqual({
        type: 'credits.purchased',
        eventId: 'evt_credits',
        providerId: 'creem',
        userId: 'u1',
        packId: 'starter',
        paymentRef: 'chk_credits',
      })
    } finally {
      pack.productIds.creem = original
    }
  })

  test('unrelated event types short-circuit to ignored before any field digging', async () => {
    expect(await deliver({ id: 'evt_9', eventType: 'dispute.created', object: {} }))
      .toEqual({ type: 'ignored', eventId: 'evt_9' })
  })
})

describe('provider capabilities', () => {
  test('creem has no portal but cancels at period end', () => {
    const provider = createCreemProvider(ENV)
    expect(provider.supportsPortal).toBe(false)
    expect(provider.cancelMode).toBe('at_period_end')
    expect(provider.id).toBe('creem')
  })

  test('createPortalSession throws with an actionable message', async () => {
    await expect(createCreemProvider(ENV).createPortalSession('cus', 'https://x')).rejects.toThrow(/no customer portal/)
  })
})
