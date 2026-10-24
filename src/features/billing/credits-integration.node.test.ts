/**
 * Credits ↔ billing seam tests (node pool, no D1).
 *
 * Slice A owns the pure credits core; this file covers the *billing* side of
 * the boundary: how an inbound vendor event is routed when the product it
 * references is a credit pack. The interesting seam is `translateStripeEvent`,
 * because Stripe is the only adapter whose translation lives in the shared
 * `entitlement` module.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { translateStripeEvent } from '@/features/billing/entitlement'
import { classifyPurchase } from '@/features/credits/credits.core'
import { creditPacks } from '@/features/credits/credit-packs'

// The shipped packs have all-empty product ids, so a test that needs a
// configured pack pins one for the duration. `withPackProduct` restores it, and
// `afterEach` re-asserts the invariant so a failed assertion inside a test can
// never leak a mutated pack into the next one (module-level singletons are
// shared across every test file in the node pool).
const SHIPPED_PRODUCT_IDS = creditPacks.map((p) => ({ id: p.id, productIds: { ...p.productIds } }))

afterEach(() => {
  for (const shipped of SHIPPED_PRODUCT_IDS) {
    const pack = creditPacks.find((p) => p.id === shipped.id)
    if (!pack) continue
    for (const [provider, productId] of Object.entries(shipped.productIds)) {
      pack.productIds[provider as keyof typeof pack.productIds] = productId
    }
  }
})

function withPackProduct<T extends 'stripe' | 'creem' | 'waffo' | 'paypal'>(
  packId: string,
  provider: T,
  productId: string,
  fn: () => void,
): void {
  const pack = creditPacks.find((p) => p.id === packId)!
  const original = pack.productIds[provider]
  pack.productIds[provider] = productId
  try {
    fn()
  } finally {
    pack.productIds[provider] = original
  }
}

describe('credits-integration: classifyPurchase across providers', () => {
  test('a configured credit-pack product id classifies as credits for every provider', () => {
    for (const [provider, productId] of [
      ['stripe', 'price_starter'],
      ['creem', 'creem_starter'],
      ['waffo', 'waffo_starter'],
      ['paypal', 'CRED-starter'],
    ] as const) {
      withPackProduct('starter', provider, productId, () => {
        const result = classifyPurchase(provider, productId)
        expect(result.kind).toBe('credits')
        if (result.kind === 'credits') expect(result.pack.id).toBe('starter')
      })
    }
  })

  test('a non-pack product id classifies as lifetime for every provider', () => {
    expect(classifyPurchase('stripe', 'price_pro')).toEqual({ kind: 'lifetime' })
    expect(classifyPurchase('creem', 'prod_pro')).toEqual({ kind: 'lifetime' })
    expect(classifyPurchase('waffo', 'waffo_pro')).toEqual({ kind: 'lifetime' })
    expect(classifyPurchase('paypal', 'P-ABC')).toEqual({ kind: 'lifetime' })
  })
})

describe('credits-integration: translateStripeEvent routes credit packs', () => {
  test('checkout.session.completed with a credit-pack productId → credits.purchased', () => {
    withPackProduct('growth', 'stripe', 'price_growth', () => {
      const ev: any = {
        id: 'evt_credits_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'payment',
            payment_status: 'paid',
            customer: 'cus_9',
            client_reference_id: 'user_1',
            payment_intent: 'pi_credits_1',
            metadata: { productId: 'price_growth' },
          },
        },
      }
      expect(translateStripeEvent(ev)).toEqual({
        type: 'credits.purchased',
        eventId: 'evt_credits_1',
        providerId: 'stripe',
        userId: 'user_1',
        packId: 'growth',
        paymentRef: 'pi_credits_1',
      })
    })
  })

  test('async_payment_succeeded (delayed capture) with a credit-pack productId → credits.purchased', () => {
    withPackProduct('scale', 'stripe', 'price_scale', () => {
      const ev: any = {
        id: 'evt_credits_2',
        type: 'checkout.session.async_payment_succeeded',
        data: {
          object: {
            mode: 'payment',
            payment_status: 'paid',
            client_reference_id: 'user_2',
            payment_intent: 'pi_credits_2',
            metadata: { productId: 'price_scale' },
          },
        },
      }
      expect(translateStripeEvent(ev)).toEqual({
        type: 'credits.purchased',
        eventId: 'evt_credits_2',
        providerId: 'stripe',
        userId: 'user_2',
        packId: 'scale',
        paymentRef: 'pi_credits_2',
      })
    })
  })

  test('a non-pack productId in metadata → lifetime purchase.completed (legacy shape)', () => {
    const ev: any = {
      id: 'evt_life_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          customer: 'cus_9',
          client_reference_id: 'user_3',
          payment_intent: 'pi_life_3',
          metadata: { productId: 'price_pro_monthly' },
        },
      },
    }
    expect(translateStripeEvent(ev)).toEqual({
      type: 'purchase.completed',
      eventId: 'evt_life_1',
      providerId: 'stripe',
      userId: 'user_3',
      customerId: 'cus_9',
      plan: null,
      productId: 'price_pro_monthly',
      paymentRef: 'pi_life_3',
    })
  })

  test('no metadata at all → legacy lifetime purchase (unchanged)', () => {
    const ev: any = {
      id: 'evt_legacy_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          customer: 'cus_9',
          client_reference_id: 'user_4',
          payment_intent: 'pi_legacy_1',
        },
      },
    }
    // A legacy lifetime checkout carries no credits metadata; that path must keep
    // working exactly as before.
    expect(translateStripeEvent(ev)).toEqual({
      type: 'purchase.completed',
      eventId: 'evt_legacy_1',
      providerId: 'stripe',
      userId: 'user_4',
      customerId: 'cus_9',
      plan: null,
      productId: null,
      paymentRef: 'pi_legacy_1',
    })
  })

  test('metadata declaring kind=credits but matching no pack is ignored, never a lifetime grant', () => {
    // The dangerous case: the customer paid for credits, but the pack's Stripe
    // product id is blank/misconfigured. Falling through to `purchase.completed`
    // would hand them a lifetime Pro instead of the credits they bought.
    const ev: any = {
      id: 'evt_mispinned',
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          customer: 'cus_9',
          client_reference_id: 'user_7',
          payment_intent: 'pi_mispinned',
          metadata: { kind: 'credits', packId: 'starter', productId: 'price_not_configured', provider: 'stripe' },
        },
      },
    }
    expect(translateStripeEvent(ev)).toEqual({ type: 'ignored', eventId: 'evt_mispinned' })
  })

  test('metadata declaring kind=credits with no productId is ignored, never a lifetime grant', () => {
    const ev: any = {
      id: 'evt_nopid',
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          customer: 'cus_9',
          client_reference_id: 'user_8',
          payment_intent: 'pi_nopid',
          metadata: { kind: 'credits', packId: 'starter', provider: 'stripe' },
        },
      },
    }
    expect(translateStripeEvent(ev)).toEqual({ type: 'ignored', eventId: 'evt_nopid' })
  })

  test('the metadata startCreditCheckout writes routes the purchase to credits', () => {
    // End-to-end seam: whatever `startCreditCheckout` puts in the session
    // metadata must classify back to the same pack. This is the regression test
    // for the bug where the product id was never echoed into metadata, so every
    // real Stripe credit-pack purchase was mis-granted as a lifetime Pro.
    const checkoutMetadata = {
      kind: 'credits',
      packId: 'starter',
      // exactly what `startCreditCheckout` now writes:
      productId: 'price_starter_credits',
      userId: 'user_6',
      provider: 'stripe',
    }
    withPackProduct('starter', 'stripe', checkoutMetadata.productId, () => {
      const ev: any = {
        id: 'evt_roundtrip_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'payment',
            payment_status: 'paid',
            customer: 'cus_roundtrip',
            client_reference_id: checkoutMetadata.userId,
            payment_intent: 'pi_roundtrip_1',
            metadata: checkoutMetadata,
          },
        },
      }
      const routed = translateStripeEvent(ev)
      expect(routed).toMatchObject({
        type: 'credits.purchased',
        packId: 'starter',
        userId: 'user_6',
        paymentRef: 'pi_roundtrip_1',
      })
    })
  })

  test('a credit-pack productId is NOT classified when payment_status is unpaid', () => {
    // The routing happens only after the paid check, so an unpaid delayed
    // payment stays ignored regardless of metadata.
    withPackProduct('starter', 'stripe', 'price_starter', () => {
      const ev: any = {
        id: 'evt_credits_unpaid',
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'payment',
            payment_status: 'unpaid',
            client_reference_id: 'user_5',
            payment_intent: 'pi_credits_unpaid',
            metadata: { productId: 'price_starter' },
          },
        },
      }
      expect(translateStripeEvent(ev)).toEqual({ type: 'ignored', eventId: 'evt_credits_unpaid' })
    })
  })
})
