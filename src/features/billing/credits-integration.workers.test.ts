/**
 * Credits ↔ billing integration tests (workers pool, real D1).
 *
 * Covers the seam between the two slices:
 *   1. `credits.purchased` through `handleWebhook` credits a user with no
 *      subscription row exactly once across duplicate event ids.
 *   2. A refund of that purchase claws the credits back, clamping at zero when
 *      some were already spent.
 *   3. A refund for a lifetime-only subscriber still takes the lifetime path and
 *      touches no credit ledger rows.
 *   4. `startCreditCheckout` returns the provider session URL and writes no
 *      subscription row.
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { createDb, type DB } from '@/db/client'
import { subscription } from './billing.schema'
import { creditAccount, creditLedger } from '@/features/credits/credits.schema'
import { handleWebhook, applyDomainEvent, getEntitlementFor, startCreditCheckout } from './billing.server'
import { consumeCredits } from '@/features/credits/credits.server'
import { applyBillingSchema, seedUserAndSubscription } from './test-helpers'
import { applyCreditsSchema, seedUser } from '@/features/credits/test-helpers'
import { creditPacks } from '@/features/credits/credit-packs'
import type { PaymentProvider, CheckoutInput } from './payment'
import type { ProviderId } from './providers/catalog'
import type { DomainEvent } from './entitlement'

// Credits schema first: its `user` table carries `role`, which the credits
// server reads. The billing schema's `user` CREATE is then a no-op.
beforeAll(async () => {
  await applyCreditsSchema(env.DB)
  await applyBillingSchema(env.DB)
  // A configured Stripe so `resolveCreditPack` can resolve the starter pack.
  env.BILLING_PROVIDERS = 'stripe'
  env.STRIPE_SECRET_KEY = 'sk_test'
  env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
  // The default hook builds an absolute URL for the confirmation email.
  env.BETTER_AUTH_URL = 'https://app.test'
})

/** `handleWebhook` with the provider id, body and headers filled in. */
function fire(db: DB, event: DomainEvent, now: number, providerId?: ProviderId) {
  return handleWebhook(db, providerId ?? 'stripe', async () => event, 'raw-body', {}, now)
}

describe('1. credits.purchased credits a free user once', () => {
  test('a user with no subscription row gets the pack credits; a duplicate eventId is a no-op', async () => {
    const db = createDb(env.DB)
    const userId = `cr-${crypto.randomUUID()}`
    await seedUser(db, userId) // user row only — no subscription, no credit account
    const now = Date.UTC(2026, 9, 15)
    const paymentRef = `pi_cr_${crypto.randomUUID().slice(0, 8)}`
    const event: DomainEvent = {
      type: 'credits.purchased', eventId: 'evt_cr_1', providerId: 'stripe',
      userId, packId: 'starter', paymentRef,
    }

    expect(await fire(db, event, now)).toBe(200)

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(1_000)
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    expect(ledger).toHaveLength(1)
    expect(ledger[0]?.kind).toBe('purchase')
    expect(ledger[0]?.delta).toBe(1_000)
    expect(ledger[0]?.ref).toBe(paymentRef)

    // Duplicate event id → idempotent, no second grant.
    expect(await fire(db, event, now + 1_000)).toBe(200)
    const acct2 = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct2[0]?.balance).toBe(1_000)
    const ledger2 = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    expect(ledger2).toHaveLength(1)
  })
})

describe('2. refund claws back credits and clamps at zero', () => {
  test('a partially spent purchase is clamped to the remaining balance', async () => {
    const db = createDb(env.DB)
    const userId = `cr-r-${crypto.randomUUID()}`
    await seedUser(db, userId)
    const now = Date.UTC(2026, 9, 15)
    const paymentRef = `pi_cr_r_${crypto.randomUUID().slice(0, 8)}`

    await fire(db, {
      type: 'credits.purchased', eventId: 'evt_cr_r_1', providerId: 'stripe',
      userId, packId: 'starter', paymentRef,
    }, now)

    // Spend 300 of the 1000 → balance 700.
    const spent = await consumeCredits(db, { userId, cost: 300, idempotencyKey: `spend:${userId}` }, now)
    expect(spent.ok).toBe(true)

    // Stripe refunds carry no client_reference_id — resolve by paymentRef alone.
    const status = await fire(db, {
      type: 'purchase.refunded', eventId: 'evt_cr_r_2', providerId: 'stripe',
      userId: null, customerId: 'cus_refund', paymentRef,
    }, now + 1_000)
    expect(status).toBe(200)

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(0) // clamped, never negative

    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    const refund = ledger.find((r) => r.kind === 'refund')
    expect(refund).toBeDefined()
    expect(refund?.delta).toBe(-700) // the actual reversed amount
    expect(refund?.balanceAfter).toBe(0)
    expect(refund?.ref).toBe(paymentRef)
    expect(refund?.note).toMatch(/clamp/i)
  })

  test('a full refund reverses the whole grant with no clamp note', async () => {
    const db = createDb(env.DB)
    const userId = `cr-rf-${crypto.randomUUID()}`
    await seedUser(db, userId)
    const now = Date.UTC(2026, 9, 15)
    const paymentRef = `pi_cr_rf_${crypto.randomUUID().slice(0, 8)}`

    await fire(db, {
      type: 'credits.purchased', eventId: 'evt_cr_rf_1', providerId: 'stripe',
      userId, packId: 'starter', paymentRef,
    }, now)

    expect(await fire(db, {
      type: 'purchase.refunded', eventId: 'evt_cr_rf_2', providerId: 'stripe',
      userId: null, customerId: 'cus_refund', paymentRef,
    }, now + 1_000)).toBe(200)

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(0)
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    const refund = ledger.find((r) => r.kind === 'refund')
    expect(refund?.delta).toBe(-1_000)
    expect(refund?.note ?? '').not.toMatch(/clamp/i)
  })
})

describe('3. a lifetime-only subscriber refund takes the lifetime path', () => {
  test('no credit ledger rows are touched', async () => {
    const db = createDb(env.DB)
    const userId = `cr-l-${crypto.randomUUID()}`
    const customerId = `cus_cr_l_${crypto.randomUUID().slice(0, 8)}`
    await seedUser(db, userId)
    await seedUserAndSubscription(db, {
      userId, customerId, status: 'active', plan: 'pro',
      lifetime: true, lifetimePaymentRef: 'pi_life_1',
    })

    const before = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    expect(before).toHaveLength(0)

    const transition = await applyDomainEvent(db, {
      type: 'purchase.refunded', eventId: 'evt_cr_l_1', providerId: 'stripe',
      userId: null, customerId, paymentRef: 'pi_life_1',
    }, Date.UTC(2026, 9, 15))
    expect(transition).toEqual({ kind: 'deactivated', userId, reason: 'refunded' })

    const ent = await getEntitlementFor(db, userId)
    expect(ent.lifetime).toBe(false)
    expect(ent.plan).toBe('free')

    const after = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    expect(after).toHaveLength(0)
  })
})

describe('4. startCreditCheckout', () => {
  test('returns the provider session URL and writes no subscription row', async () => {
    // Pin a Stripe product id on the real starter pack for the duration.
    const pack = creditPacks.find((p) => p.id === 'starter')!
    const original = pack.productIds.stripe
    pack.productIds.stripe = 'price_starter'

    let captured: CheckoutInput | null = null
    const stub: PaymentProvider = {
      id: 'stripe',
      displayName: 'Stripe',
      supportsPortal: true,
      cancelMode: 'at_period_end',
      ensureCustomer: async () => null,
      createCheckoutSession: async (input) => {
        captured = input
        return { url: 'https://checkout.example/credits' }
      },
      createPortalSession: async () => ({ url: 'https://portal.example' }),
      parseWebhook: async () => ({ type: 'ignored', eventId: 'x' }),
      cancelSubscription: async () => {},
    }

    const db = createDb(env.DB)
    const userId = `cr-c-${crypto.randomUUID()}`
    await seedUser(db, userId)

    try {
      const { url } = await startCreditCheckout(db, stub, { id: userId, email: `${userId}@t.io` }, 'starter', 'https://s', 'https://c')
      expect(url).toBe('https://checkout.example/credits')

      expect(captured).not.toBeNull()
      const input = captured!
      expect(input.mode).toBe('payment')
      expect(input.productId).toBe('price_starter')
      expect(input.userId).toBe(userId)
      expect(input.metadata).toMatchObject({ kind: 'credits', packId: 'starter', userId, provider: 'stripe' })
      // Stripe's checkout.session.completed carries no line-item price, so the
      // product id MUST round-trip through metadata — without it the webhook
      // cannot tell a credit pack from a plan and mis-grants a lifetime Pro.
      expect(input.metadata?.productId).toBe('price_starter')

      // The subscription table must be untouched.
      const subs = await db.select().from(subscription).where(eq(subscription.userId, userId))
      expect(subs).toHaveLength(0)
    } finally {
      pack.productIds.stripe = original
    }
  })

  test('refuses an unconfigured pack with the resolveCreditPack reason', async () => {
    const db = createDb(env.DB)
    const userId = `cr-cx-${crypto.randomUUID()}`
    await seedUser(db, userId)
    const stub: PaymentProvider = {
      id: 'stripe',
      displayName: 'Stripe',
      supportsPortal: true,
      cancelMode: 'at_period_end',
      ensureCustomer: async () => null,
      createCheckoutSession: async () => { throw new Error('should not be called') },
      createPortalSession: async () => ({ url: 'x' }),
      parseWebhook: async () => ({ type: 'ignored', eventId: 'x' }),
      cancelSubscription: async () => {},
    }
    // 'nope' is not a shipped pack → unknown pack, thrown before any provider call.
    await expect(
      startCreditCheckout(db, stub, { id: userId, email: `${userId}@t.io` }, 'nope', 'https://s', 'https://c'),
    ).rejects.toThrow(/Unknown credit pack/)
  })
})

describe('5. onProActivated grants the plan-upgrade credit delta', () => {
  test('a free user upgrading to Pro gets topped up to the Pro allowance', async () => {
    const db = createDb(env.DB)
    const userId = `cr-h-${crypto.randomUUID()}`
    await seedUser(db, userId)
    // A free-tier monthly grant already made this period (100).
    await db.insert(creditAccount).values({
      userId, balance: 100, periodKey: '2026-10', periodGrant: 100,
      lifetimePurchased: 0, lifetimeConsumed: 0,
      createdAt: new Date(Date.UTC(2026, 9, 1)), updatedAt: new Date(Date.UTC(2026, 9, 1)),
    })
    // The subscription row is already the upgraded plan (the hook fires after
    // the webhook has written it).
    await seedUserAndSubscription(db, { userId, customerId: `cus_${crypto.randomUUID().slice(0, 8)}`, status: 'active', plan: 'pro', subscriptionId: 'sub_h', priceId: 'price_pro' })

    const { billingHooks } = await import('./hooks')
    await billingHooks.onProActivated!({ db, userId, email: `${userId}@t.io` }, 'subscription')

    const acct = await db.select().from(creditAccount).where(eq(creditAccount.userId, userId))
    expect(acct[0]?.balance).toBe(5_000) // 100 free + 4_900 upgrade
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    const upgrade = ledger.find((r) => r.kind === 'grant.upgrade')
    expect(upgrade?.delta).toBe(4_900)
    expect(upgrade?.note).toMatch(/plan upgraded to pro/)
  })

  test('a user already at the new tier gets no upgrade grant', async () => {
    const db = createDb(env.DB)
    const userId = `cr-h2-${crypto.randomUUID()}`
    await seedUser(db, userId)
    await db.insert(creditAccount).values({
      userId, balance: 5_000, periodKey: '2026-10', periodGrant: 5_000,
      lifetimePurchased: 0, lifetimeConsumed: 0,
      createdAt: new Date(Date.UTC(2026, 9, 1)), updatedAt: new Date(Date.UTC(2026, 9, 1)),
    })
    await seedUserAndSubscription(db, { userId, customerId: `cus_${crypto.randomUUID().slice(0, 8)}`, status: 'active', plan: 'pro', subscriptionId: 'sub_h2', priceId: 'price_pro' })

    const { billingHooks } = await import('./hooks')
    await billingHooks.onProActivated!({ db, userId, email: `${userId}@t.io` }, 'subscription')

    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))
    expect(ledger).toHaveLength(0)
  })
})
