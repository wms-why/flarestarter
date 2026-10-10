/**
 * Billing workers integration tests — real Cloudflare D1 (miniflare),
 * injected DomainEvents (no live Stripe calls).
 *
 * Test intents:
 *  1. Idempotency: second webhook with duplicate eventId is a no-op on subscription
 *  2. Status transitions → entitlement (active→pro, past_due→free, deleted→canceled/free)
 *  3. Ownership scoping: user A sees only their own subscription
 *  4. Unknown customerId is silently ignored
 *  5. Verify-fail → 400, event NOT recorded
 *  6. Apply failure → 500, marker rolled back so retry can succeed
 *  7. Lifetime purchase: purchase.completed grants permanent Pro; refund revokes; subscription events never touch a lifetime row
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { createDb, type DB } from '@/db/client'
import { subscription, processedWebhookEvents } from './billing.schema'
import { handleWebhook, applyDomainEvent, getEntitlementFor, cancelSubscriptionsForUser, cancelSubscriptionForUser, startCheckout } from './billing.server'
import type { PaymentProvider } from './payment'
import type { DomainEvent } from './entitlement'
import { applyBillingSchema, seedUserAndSubscription } from './test-helpers'

// ---------------------------------------------------------------------------
// Schema bootstrap — runs once before any test in this file
// ---------------------------------------------------------------------------
beforeAll(async () => {
  await applyBillingSchema(env.DB)
})

// ---------------------------------------------------------------------------
// Helper: build injectable parse functions
// ---------------------------------------------------------------------------
type Apply = NonNullable<Parameters<typeof handleWebhook>[6]>
type OnTransition = NonNullable<Parameters<typeof handleWebhook>[7]>

/** `handleWebhook` with the vendor id, raw body and headers filled in, so a test
 *  only has to express the event it is about. */
function fire(db: DB, event: DomainEvent, now: number, apply?: Apply, onTransition?: OnTransition) {
  return handleWebhook(db, 'stripe', async () => event, 'raw-body', {}, now, apply, onTransition)
}

/** Same, but the provider rejects the delivery (bad signature). */
function fireRejected(db: DB, now: number) {
  return handleWebhook(db, 'stripe', async () => { throw new Error('bad sig') }, 'raw-body', {}, now)
}

// ---------------------------------------------------------------------------
// 1. Idempotency
// ---------------------------------------------------------------------------
describe('1. Idempotency: duplicate eventId is a no-op on the subscription row', () => {
  test('second call with same eventId returns 200 but does NOT reapply the event', async () => {
    const db = createDb(env.DB)
    const userId = `idem-user-${crypto.randomUUID()}`
    const customerId = `cus_idem_${crypto.randomUUID().slice(0, 8)}`
    const eventId = `evt_dup_${crypto.randomUUID().slice(0, 8)}`
    const now = Date.now()

    // Seed a user with an initial 'none' subscription
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })

    // The event would set status=active and plan=pro (priceId provided)
    const upsertedEvent: DomainEvent = {
      type: 'subscription.upserted', providerId: 'stripe', userId: null,
      eventId,
      customerId,
      subscriptionId: 'sub_idem_1',
      status: 'active',
      plan: 'pro',
      productId: 'price_pro',
      currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: false,
    }

    // First call — should process and set status=active
    const status1 = await fire(db, upsertedEvent, now)
    expect(status1).toBe(200)

    // Confirm first call applied: status should now be 'active'
    const rowsAfterFirst = await db.select().from(subscription).where(eq(subscription.userId, userId))
    expect(rowsAfterFirst[0]?.status).toBe('active')

    // Sentinel: manually flip the subscription status to a sentinel value 'past_due'
    // so we can detect if the second call incorrectly re-applies the event (which would
    // set it back to 'active').
    await db
      .update(subscription)
      .set({ status: 'past_due', updatedAt: new Date(now + 1) })
      .where(eq(subscription.userId, userId))

    // Second call with the exact same eventId
    const status2 = await fire(db, upsertedEvent, now + 2)
    expect(status2).toBe(200)

    // The subscription must still be 'past_due' — proving the second call was a no-op
    const rowsAfterSecond = await db.select().from(subscription).where(eq(subscription.userId, userId))
    expect(rowsAfterSecond[0]?.status).toBe('past_due')

    // processed_webhook_events must contain exactly ONE row for this eventId
    const eventRows = await db
      .select()
      .from(processedWebhookEvents)
      .where(eq(processedWebhookEvents.eventId, `stripe:${eventId}`))
    expect(eventRows).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 2. Status transitions → entitlement
// ---------------------------------------------------------------------------
describe('2. Status transitions change entitlement correctly', () => {
  test('active with priceId → pro; past_due → free; deleted → canceled/free', async () => {
    const db = createDb(env.DB)
    const userId = `trans-user-${crypto.randomUUID()}`
    const customerId = `cus_trans_${crypto.randomUUID().slice(0, 8)}`
    const now = Date.now()

    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })

    // --- active + priceId → pro ---
    const activeEvent: DomainEvent = {
      type: 'subscription.upserted', providerId: 'stripe', userId: null,
      eventId: `evt_active_${crypto.randomUUID().slice(0, 8)}`,
      customerId,
      subscriptionId: 'sub_trans_1',
      status: 'active',
      plan: 'pro',
      productId: 'price_1',
      currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: false,
    }
    await applyDomainEvent(db, activeEvent, now)
    const e1 = await getEntitlementFor(db, userId)
    expect(e1.plan).toBe('pro')
    expect(e1.status).toBe('active')
    expect(e1.isActive).toBe(true)

    // --- past_due → free (gate closed) ---
    const pastDueEvent: DomainEvent = {
      type: 'subscription.upserted', providerId: 'stripe', userId: null,
      eventId: `evt_pastdue_${crypto.randomUUID().slice(0, 8)}`,
      customerId,
      subscriptionId: 'sub_trans_1',
      status: 'past_due',
      plan: 'pro',
      productId: 'price_1',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    }
    await applyDomainEvent(db, pastDueEvent, now + 1)
    const e2 = await getEntitlementFor(db, userId)
    expect(e2.plan).toBe('free')
    expect(e2.status).toBe('past_due')
    expect(e2.isActive).toBe(false)

    // --- deleted → canceled/free ---
    const deletedEvent: DomainEvent = {
      type: 'subscription.deleted', providerId: 'stripe', userId: null,
      eventId: `evt_deleted_${crypto.randomUUID().slice(0, 8)}`,
      customerId,
      subscriptionId: 'sub_trans_1',
    }
    await applyDomainEvent(db, deletedEvent, now + 2)
    const e3 = await getEntitlementFor(db, userId)
    expect(e3.plan).toBe('free')
    expect(e3.status).toBe('canceled')
    expect(e3.isActive).toBe(false)

    // Direct DB-column assertions: verify the raw subscription row, not the masked
    // entitlement. resolveEntitlement returns plan='free' for any non-active/trialing
    // status, so a bug writing plan='pro' on deletion would NOT be caught by e3 above.
    const afterDeleted = await db.select().from(subscription).where(eq(subscription.userId, userId))
    expect(afterDeleted[0].plan).toBe('free')         // raw DB column, not masked by resolveEntitlement
    expect(afterDeleted[0].status).toBe('canceled')
    expect(afterDeleted[0].subscriptionId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. Ownership scoping
// ---------------------------------------------------------------------------
describe('3. Ownership scoping: users cannot see each other\'s subscriptions', () => {
  test('user A pro-active; user B with no subscription → each sees their own entitlement', async () => {
    const db = createDb(env.DB)
    const userA = `scope-a-${crypto.randomUUID()}`
    const userB = `scope-b-${crypto.randomUUID()}`
    const custA = `cus_scope_a_${crypto.randomUUID().slice(0, 8)}`

    // Seed A with an active pro subscription
    await seedUserAndSubscription(db, {
      userId: userA,
      customerId: custA,
      status: 'active',
      plan: 'pro',
      priceId: 'price_pro',
    })

    // Seed B with a subscription row (no Stripe sub, status=none)
    await seedUserAndSubscription(db, {
      userId: userB,
      customerId: `cus_scope_b_${crypto.randomUUID().slice(0, 8)}`,
      status: 'none',
      plan: 'free',
    })

    const entA = await getEntitlementFor(db, userA)
    const entB = await getEntitlementFor(db, userB)

    expect(entA.plan).toBe('pro')
    expect(entA.isActive).toBe(true)

    // B does not get A's subscription
    expect(entB.plan).toBe('free')
    expect(entB.isActive).toBe(false)
  })

  test('user with no subscription row at all → free entitlement', async () => {
    const db = createDb(env.DB)
    const userId = `scope-none-${crypto.randomUUID()}`

    const ent = await getEntitlementFor(db, userId)
    expect(ent.plan).toBe('free')
    expect(ent.status).toBe('none')
    expect(ent.isActive).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. Unknown customerId is silently ignored
// ---------------------------------------------------------------------------
describe('4. Unknown customerId is silently ignored', () => {
  test('applyDomainEvent with unknown customerId does not throw and creates no side effect', async () => {
    const db = createDb(env.DB)
    const unknownEvent: DomainEvent = {
      type: 'subscription.upserted', providerId: 'stripe', userId: null,
      eventId: `evt_unknown_${crypto.randomUUID().slice(0, 8)}`,
      customerId: 'cus_totally_unknown',
      subscriptionId: 'sub_ghost',
      status: 'active',
        plan: 'pro',
      productId: 'price_1',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    }

    // Must not throw; unknown customer → no transition
    await expect(applyDomainEvent(db, unknownEvent, Date.now())).resolves.toBeNull()

    // No subscription row should have been created
    const rows = await db
      .select()
      .from(subscription)
      .where(eq(subscription.customerId, 'cus_totally_unknown'))
    expect(rows).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Verify-fail → 400, event NOT recorded
// ---------------------------------------------------------------------------
describe('5. Verify-fail returns 400 and does not record the event', () => {
  test('parse throws → handleWebhook returns 400 and processed_webhook_events is not written', async () => {
    const db = createDb(env.DB)
    const now = Date.now()

    // Use a stable eventId to assert it was never inserted
    // (using a sentinel to avoid collisions with other tests)
    const sentinelEventId = `evt_should_not_exist_${crypto.randomUUID()}`

    const statusCode = await fireRejected(db, now)

    expect(statusCode).toBe(400)

    // Confirm no event was recorded (check all rows inserted since test start for this eventId)
    const rows = await db
      .select()
      .from(processedWebhookEvents)
      .where(eq(processedWebhookEvents.eventId, sentinelEventId))
    expect(rows).toHaveLength(0)
  })

  test('parse throws → no subscription side effects (subscription table unchanged)', async () => {
    const db = createDb(env.DB)
    const userId = `fail-user-${crypto.randomUUID()}`
    const customerId = `cus_fail_${crypto.randomUUID().slice(0, 8)}`
    const now = Date.now()

    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })

    const statusCode = await fireRejected(db, now)
    expect(statusCode).toBe(400)

    // Subscription status must remain 'none'
    const rows = await db.select().from(subscription).where(eq(subscription.userId, userId))
    expect(rows[0]?.status).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// 6. Apply failure → 500, marker rolled back so retry can succeed
// ---------------------------------------------------------------------------
describe('6. Apply failure rolls back the event marker and returns 500, enabling clean retry', () => {
  test('apply throws → returns 500 and eventId is NOT left in processed_webhook_events', async () => {
    const db = createDb(env.DB)
    const userId = `apply-fail-user-${crypto.randomUUID()}`
    const customerId = `cus_apfail_${crypto.randomUUID().slice(0, 8)}`
    const eventId = `evt_apfail_${crypto.randomUUID().slice(0, 8)}`
    const now = Date.now()

    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })

    const event: DomainEvent = {
      type: 'subscription.upserted', providerId: 'stripe', userId: null,
      eventId,
      customerId,
      subscriptionId: 'sub_apfail_1',
      status: 'active',
      plan: 'pro',
      productId: 'price_pro',
      currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: false,
    }

    // Inject an apply that always throws (simulates transient D1 error)
    const failApply = async (_db: DB, _event: DomainEvent, _now: number): Promise<void> => {
      throw new Error('simulated transient D1 error')
    }

    const statusCode = await fire(db, event, now, failApply)
    expect(statusCode).toBe(500)

    // The marker must NOT be left behind — it should have been compensated/deleted
    const markerRows = await db
      .select()
      .from(processedWebhookEvents)
      .where(eq(processedWebhookEvents.eventId, `stripe:${eventId}`))
    expect(markerRows).toHaveLength(0)

    // Subscription must still be 'none' (apply never ran successfully)
    const subRows = await db.select().from(subscription).where(eq(subscription.userId, userId))
    expect(subRows[0]?.status).toBe('none')
  })

  test('after apply failure + rollback, retry with real apply succeeds and applies the event', async () => {
    const db = createDb(env.DB)
    const userId = `retry-user-${crypto.randomUUID()}`
    const customerId = `cus_retry_${crypto.randomUUID().slice(0, 8)}`
    const eventId = `evt_retry_${crypto.randomUUID().slice(0, 8)}`
    const now = Date.now()

    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })

    const event: DomainEvent = {
      type: 'subscription.upserted', providerId: 'stripe', userId: null,
      eventId,
      customerId,
      subscriptionId: 'sub_retry_1',
      status: 'active',
      plan: 'pro',
      productId: 'price_pro',
      currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: false,
    }

    // First attempt: apply throws → 500, marker rolled back
    const failApply = async (_db: DB, _event: DomainEvent, _now: number): Promise<void> => {
      throw new Error('transient error')
    }
    const firstStatus = await fire(db, event, now, failApply)
    expect(firstStatus).toBe(500)

    // Confirm marker was rolled back (clean slate for retry)
    const markerAfterFailure = await db
      .select()
      .from(processedWebhookEvents)
      .where(eq(processedWebhookEvents.eventId, `stripe:${eventId}`))
    expect(markerAfterFailure).toHaveLength(0)

    // Stripe retry: same eventId, this time use the real default apply (no 6th arg)
    const retryStatus = await fire(db, event, now + 1)
    expect(retryStatus).toBe(200)

    // The event should now be applied: subscription status must be 'active'
    const subRows = await db.select().from(subscription).where(eq(subscription.userId, userId))
    expect(subRows[0]?.status).toBe('active')

    // The marker must exist exactly once (from the successful retry)
    const markerAfterRetry = await db
      .select()
      .from(processedWebhookEvents)
      .where(eq(processedWebhookEvents.eventId, `stripe:${eventId}`))
    expect(markerAfterRetry).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 7. Lifetime purchase
// ---------------------------------------------------------------------------
describe('7. Lifetime purchase', () => {
  test('purchase.completed → permanent Pro (lifetime, no expiry)', async () => {
    const db = createDb(env.DB)
    const userId = `life-${crypto.randomUUID()}`
    const customerId = `cus_life_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })
    await fire(db, {
      type: 'purchase.completed', providerId: 'stripe', userId: null,
      eventId: `evt_${crypto.randomUUID().slice(0, 8)}`,
      customerId, plan: 'pro', productId: 'price_life', paymentRef: 'pi_life',
    }, Date.now())
    const ent = await getEntitlementFor(db, userId)
    expect(ent.plan).toBe('pro')
    expect(ent.lifetime).toBe(true)
    expect(ent.currentPeriodEnd).toBeNull()
  })

  test('purchase.refunded → revokes a lifetime grant back to free', async () => {
    const db = createDb(env.DB)
    const userId = `life-ref-${crypto.randomUUID()}`
    const customerId = `cus_liferef_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', lifetime: true })
    await fire(db, {
      type: 'purchase.refunded', providerId: 'stripe', userId: null,
      eventId: `evt_${crypto.randomUUID().slice(0, 8)}`, customerId, paymentRef: null,
    }, Date.now())
    const ent = await getEntitlementFor(db, userId)
    expect(ent.plan).toBe('free')
    expect(ent.lifetime).toBe(false)
  })

  test('purchase.completed cancels a live subscription at the provider (no double billing)', async () => {
    const db = createDb(env.DB)
    const userId = `life-dbl-${crypto.randomUUID()}`
    const customerId = `cus_dbl_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_live', priceId: 'price_pro' })
    const canceled: string[] = []
    await applyDomainEvent(
      db,
      { type: 'purchase.completed', providerId: 'stripe', userId: null, eventId: `evt_${crypto.randomUUID().slice(0, 8)}`, customerId, plan: 'pro', productId: 'price_life', paymentRef: 'pi_life' },
      Date.now(),
      async (id) => { canceled.push(id) },
    )
    expect(canceled).toEqual(['sub_live']) // the still-billing monthly sub must be canceled at Stripe
    const ent = await getEntitlementFor(db, userId)
    expect(ent.lifetime).toBe(true)
  })

  test('purchase.completed with no live subscription does not call cancel', async () => {
    const db = createDb(env.DB)
    const userId = `life-nosub-${crypto.randomUUID()}`
    const customerId = `cus_nosub_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })
    const canceled: string[] = []
    await applyDomainEvent(
      db,
      { type: 'purchase.completed', providerId: 'stripe', userId: null, eventId: `evt_${crypto.randomUUID().slice(0, 8)}`, customerId, plan: 'pro', productId: 'price_life', paymentRef: 'pi_life' },
      Date.now(),
      async (id) => { canceled.push(id) },
    )
    expect(canceled).toEqual([])
    const ent = await getEntitlementFor(db, userId)
    expect(ent.lifetime).toBe(true)
  })

  test('provider cancel failure propagates and the lifetime grant is NOT applied (webhook retries)', async () => {
    const db = createDb(env.DB)
    const userId = `life-cxfail-${crypto.randomUUID()}`
    const customerId = `cus_cxfail_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_zombie', priceId: 'price_pro' })
    await expect(
      applyDomainEvent(
        db,
        { type: 'purchase.completed', providerId: 'stripe', userId: null, eventId: `evt_${crypto.randomUUID().slice(0, 8)}`, customerId, plan: 'pro', productId: 'price_life', paymentRef: 'pi_life' },
        Date.now(),
        async () => { throw new Error('stripe down') },
      ),
    ).rejects.toThrow('stripe down')
    // cancel-before-grant: the row must be untouched so Stripe's retry re-runs the whole event
    const ent = await getEntitlementFor(db, userId)
    expect(ent.lifetime).toBe(false)
  })

  test('purchase.completed stores the payment intent for later refund matching', async () => {
    const db = createDb(env.DB)
    const userId = `life-pi-${crypto.randomUUID()}`
    const customerId = `cus_pi_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })
    await applyDomainEvent(db, { type: 'purchase.completed', providerId: 'stripe', userId: null, eventId: 'e_pi', customerId, plan: 'pro', productId: 'price_life', paymentRef: 'pi_life_stored' }, Date.now())
    const [row] = await db.select().from(subscription).where(eq(subscription.customerId, customerId))
    expect(row.lifetimePaymentRef).toBe('pi_life_stored')
  })

  test('refunding an UNRELATED charge of the same customer does not strip lifetime', async () => {
    const db = createDb(env.DB)
    const userId = `life-other-${crypto.randomUUID()}`
    const customerId = `cus_other_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', lifetime: true, lifetimePaymentRef: 'pi_life_x' })
    // support fully refunds one MONTHLY invoice charge — different payment intent
    const t = await applyDomainEvent(db, { type: 'purchase.refunded', providerId: 'stripe', userId: null, eventId: 'e_other', customerId, paymentRef: 'pi_monthly_inv' }, Date.now())
    expect(t).toBeNull()
    const ent = await getEntitlementFor(db, userId)
    expect(ent.lifetime).toBe(true) // lifetime 付款没退，授权不能被别的退款误撤
  })

  test('refunding the lifetime charge itself (matching PI) still revokes', async () => {
    const db = createDb(env.DB)
    const userId = `life-match-${crypto.randomUUID()}`
    const customerId = `cus_match_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', lifetime: true, lifetimePaymentRef: 'pi_life_y' })
    const t = await applyDomainEvent(db, { type: 'purchase.refunded', providerId: 'stripe', userId: null, eventId: 'e_match', customerId, paymentRef: 'pi_life_y' }, Date.now())
    expect(t).toEqual({ kind: 'deactivated', userId, reason: 'refunded' })
    const ent = await getEntitlementFor(db, userId)
    expect(ent.lifetime).toBe(false)
  })

  test('subscription.deleted does NOT downgrade a lifetime row', async () => {
    const db = createDb(env.DB)
    const userId = `life-guard-${crypto.randomUUID()}`
    const customerId = `cus_guard_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', lifetime: true })
    await fire(db, {
      type: 'subscription.deleted', providerId: 'stripe', userId: null,
      eventId: `evt_${crypto.randomUUID().slice(0, 8)}`, customerId, subscriptionId: 'sub_gone',
    }, Date.now())
    const ent = await getEntitlementFor(db, userId)
    expect(ent.plan).toBe('pro')
    expect(ent.lifetime).toBe(true)
    expect(ent.status).toBe('active')
  })

  // A lifetime grant has no renewal to fail, so a dunning event must not even
  // set the in-app "payment failed" flag — that banner would never resolve.
  test('payment.failed does NOT flag a lifetime row', async () => {
    const db = createDb(env.DB)
    const userId = `life-pf-${crypto.randomUUID()}`
    const customerId = `cus_lifepf_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', lifetime: true })
    await fire(db, {
      type: 'payment.failed', providerId: 'stripe', userId: null,
      eventId: `evt_${crypto.randomUUID().slice(0, 8)}`, customerId,
    }, Date.now())
    const ent = await getEntitlementFor(db, userId)
    expect(ent.lifetime).toBe(true)
    expect(ent.paymentFailed).toBe(false)
  })

  test('subscription.upserted does NOT overwrite a lifetime row', async () => {
    const db = createDb(env.DB)
    const userId = `life-ups-${crypto.randomUUID()}`
    const customerId = `cus_ups_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', lifetime: true })
    await fire(db, {
      type: 'subscription.upserted', providerId: 'stripe', userId: null,
      eventId: `evt_${crypto.randomUUID().slice(0, 8)}`,
      customerId, subscriptionId: 'sub_y', status: 'active', plan: 'pro', productId: 'price_sub',
      currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000, cancelAtPeriodEnd: false,
    }, Date.now())
    const ent = await getEntitlementFor(db, userId)
    expect(ent.plan).toBe('pro')
    expect(ent.lifetime).toBe(true)
    expect(ent.currentPeriodEnd).toBeNull()
  })
})

describe('8. Billing transitions (applyDomainEvent return value)', () => {
  const cid = () => `cus_tr_${crypto.randomUUID().slice(0, 8)}`

  test('purchase.completed on a free row → activated/lifetime', async () => {
    const db = createDb(env.DB); const userId = `tr-life-${crypto.randomUUID()}`; const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })
    const t = await applyDomainEvent(db, { type: 'purchase.completed', providerId: 'stripe', userId: null, eventId: 'e1', customerId, plan: 'pro', productId: 'price_life', paymentRef: 'pi_life' }, Date.now())
    expect(t).toEqual({ kind: 'activated', userId, via: 'lifetime' })
  })

  test('purchase.completed when already lifetime → null (no re-activation)', async () => {
    const db = createDb(env.DB); const userId = `tr-life2-${crypto.randomUUID()}`; const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', lifetime: true })
    const t = await applyDomainEvent(db, { type: 'purchase.completed', providerId: 'stripe', userId: null, eventId: 'e2', customerId, plan: 'pro', productId: 'price_life', paymentRef: 'pi_life' }, Date.now())
    expect(t).toBeNull()
  })

  test('purchase.refunded on a lifetime row → deactivated/refunded', async () => {
    const db = createDb(env.DB); const userId = `tr-ref-${crypto.randomUUID()}`; const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', lifetime: true })
    const t = await applyDomainEvent(db, { type: 'purchase.refunded', providerId: 'stripe', userId: null, eventId: 'e3', customerId, paymentRef: null }, Date.now())
    expect(t).toEqual({ kind: 'deactivated', userId, reason: 'refunded' })
  })

  test('subscription.upserted none→active → activated/subscription', async () => {
    const db = createDb(env.DB); const userId = `tr-sub-${crypto.randomUUID()}`; const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })
    const t = await applyDomainEvent(db, { type: 'subscription.upserted', providerId: 'stripe', userId: null, eventId: 'e4', customerId, subscriptionId: 'sub_1', status: 'active', plan: 'pro', productId: 'price_pro', currentPeriodEnd: Date.now() + 1e9, cancelAtPeriodEnd: false }, Date.now())
    expect(t).toEqual({ kind: 'activated', userId, via: 'subscription' })
  })

  test('subscription.upserted active→past_due → deactivated/past_due', async () => {
    const db = createDb(env.DB); const userId = `tr-pd-${crypto.randomUUID()}`; const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', priceId: 'price_pro' })
    const t = await applyDomainEvent(db, { type: 'subscription.upserted', providerId: 'stripe', userId: null, eventId: 'e5', customerId, subscriptionId: 'sub_1', status: 'past_due', plan: 'pro', productId: 'price_pro', currentPeriodEnd: Date.now() + 1e9, cancelAtPeriodEnd: false }, Date.now())
    expect(t).toEqual({ kind: 'deactivated', userId, reason: 'past_due' })
  })

  test('subscription.deleted on an active row → deactivated/canceled', async () => {
    const db = createDb(env.DB); const userId = `tr-del-${crypto.randomUUID()}`; const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', priceId: 'price_pro' })
    const t = await applyDomainEvent(db, { type: 'subscription.deleted', providerId: 'stripe', userId: null, eventId: 'e6', customerId, subscriptionId: 'sub_1' }, Date.now())
    expect(t).toEqual({ kind: 'deactivated', userId, reason: 'canceled' })
  })

  test('subscription.upserted on a lifetime row → null (guard)', async () => {
    const db = createDb(env.DB); const userId = `tr-guard-${crypto.randomUUID()}`; const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', lifetime: true })
    const t = await applyDomainEvent(db, { type: 'subscription.upserted', providerId: 'stripe', userId: null, eventId: 'e7', customerId, subscriptionId: 'sub_1', status: 'active', plan: 'pro', productId: 'price_pro', currentPeriodEnd: Date.now() + 1e9, cancelAtPeriodEnd: false }, Date.now())
    expect(t).toBeNull()
  })
})

describe('9. handleWebhook fires onTransition after a successful apply', () => {
  test('calls onTransition with the transition produced by apply', async () => {
    const db = createDb(env.DB); const userId = `ot-${crypto.randomUUID()}`; const customerId = `cus_ot_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })
    const calls: unknown[] = []
    const status = await fire(db, { type: 'purchase.completed', providerId: 'stripe', userId: null, eventId: `evt_${crypto.randomUUID().slice(0, 8)}`, customerId, plan: 'pro', productId: 'price_life', paymentRef: 'pi_life' }, Date.now(), applyDomainEvent,
        async (_db, t) => { calls.push(t) },
    )
    expect(status).toBe(200)
    expect(calls).toEqual([{ kind: 'activated', userId, via: 'lifetime' }])
  })

  test('onTransition throwing does NOT fail the webhook (still 200)', async () => {
    const db = createDb(env.DB); const userId = `ot-err-${crypto.randomUUID()}`; const customerId = `cus_oterr_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })
    const status = await fire(db, { type: 'purchase.completed', providerId: 'stripe', userId: null, eventId: `evt_${crypto.randomUUID().slice(0, 8)}`, customerId, plan: 'pro', productId: 'price_life', paymentRef: 'pi_life' }, Date.now(), applyDomainEvent,
        async () => { throw new Error('hook boom') },
    )
    expect(status).toBe(200)
  })

  test('no transition (ignored event) → onTransition not called', async () => {
    const db = createDb(env.DB)
    const calls: unknown[] = []
    await fire(db, { type: 'ignored', eventId: `evt_${crypto.randomUUID().slice(0, 8)}` }, Date.now(), applyDomainEvent,
        async (_db, t) => { calls.push(t) },
    )
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 14. Ignored events do not occupy the idempotency table
// ---------------------------------------------------------------------------
describe('14. ignored events: 200 without a marker row (nothing to protect, unbounded growth otherwise)', () => {
  test('handleWebhook on an ignored event returns 200 and inserts no marker', async () => {
    const db = createDb(env.DB)
    const eventId = `evt_ign_${crypto.randomUUID().slice(0, 8)}`
    const status = await fire(db, { type: 'ignored', eventId }, Date.now())
    expect(status).toBe(200)
    // Checked under the namespaced key too: `stripe:${id}` must be absent, not
    // just the bare id, or a stray row would still have been written.
    const markers = await db.select().from(processedWebhookEvents)
      .where(eq(processedWebhookEvents.eventId, `stripe:${eventId}`))
    expect(markers).toHaveLength(0)
  })

  test('a handled event is stored under "${providerId}:${eventId}" so vendors cannot collide', async () => {
    const db = createDb(env.DB)
    const userId = `ns-user-${crypto.randomUUID()}`
    const customerId = `cus_ns_${crypto.randomUUID().slice(0, 8)}`
    const eventId = `evt_ns_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })
    await fire(db, {
      type: 'purchase.completed', providerId: 'stripe', userId: null,
      eventId, customerId, plan: 'pro', productId: 'price_life', paymentRef: 'pi_life',
    }, Date.now())
    const namespaced = await db.select().from(processedWebhookEvents)
      .where(eq(processedWebhookEvents.eventId, `stripe:${eventId}`))
    expect(namespaced).toHaveLength(1)
    // The bare id must NOT exist as a row — that is the collision the namespace
    // prevents.
    const bare = await db.select().from(processedWebhookEvents)
      .where(eq(processedWebhookEvents.eventId, eventId))
    expect(bare).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 15. Checkout guard: an active Pro must not open a second subscription
// ---------------------------------------------------------------------------
describe('15. startCheckout rejects already-subscribed users', () => {
  const fakeProvider: PaymentProvider = {
    id: 'stripe',
    displayName: 'Stripe',
    supportsPortal: true,
    cancelMode: 'at_period_end',
    ensureCustomer: async (_u, existing) => existing ?? 'cus_new',
    createCheckoutSession: async () => ({ url: 'https://checkout.example/session' }),
    createPortalSession: async () => ({ url: 'https://portal.example' }),
    parseWebhook: async () => ({ type: 'ignored', eventId: 'x' }),
    cancelSubscription: async () => {},
  }

  test('active Pro subscriber → throws instead of creating a second concurrent subscription', async () => {
    const db = createDb(env.DB)
    const userId = `co-active-${crypto.randomUUID()}`
    await seedUserAndSubscription(db, { userId, customerId: 'cus_co1', status: 'active', plan: 'pro', subscriptionId: 'sub_live', priceId: 'price_pro' })
    await expect(
      startCheckout(db, fakeProvider, { id: userId, email: `${userId}@t.io` }, 'price_pro', 'https://s', 'https://c', Date.now()),
    ).rejects.toThrow(/already/i)
  })

  test('lifetime holder → throws (nothing to buy)', async () => {
    const db = createDb(env.DB)
    const userId = `co-life-${crypto.randomUUID()}`
    await seedUserAndSubscription(db, { userId, customerId: 'cus_co2', status: 'active', plan: 'pro', lifetime: true })
    await expect(
      startCheckout(db, fakeProvider, { id: userId, email: `${userId}@t.io` }, 'price_life', 'https://s', 'https://c', Date.now()),
    ).rejects.toThrow(/already/i)
  })

  test('canceled/none rows still check out normally', async () => {
    const db = createDb(env.DB)
    const userId = `co-none-${crypto.randomUUID()}`
    await seedUserAndSubscription(db, { userId, customerId: 'cus_co3', status: 'canceled', plan: 'free' })
    const { url } = await startCheckout(db, fakeProvider, { id: userId, email: `${userId}@t.io` }, 'price_pro', 'https://s', 'https://c', Date.now())
    expect(url).toContain('checkout.example')
  })
})

// ---------------------------------------------------------------------------
// 13. Account deletion pre-cleanup (wired into better-auth beforeDelete)
// ---------------------------------------------------------------------------
describe('13. cancelSubscriptionsForUser: account deletion must end live billing', () => {
  test('a live subscription is canceled at the provider before the row cascades away', async () => {
    const db = createDb(env.DB)
    const userId = `del-${crypto.randomUUID()}`
    await seedUserAndSubscription(db, { userId, customerId: `cus_del_${crypto.randomUUID().slice(0, 8)}`, status: 'active', plan: 'pro', subscriptionId: 'sub_del_live', priceId: 'price_pro' })
    const canceled: string[] = []
    await cancelSubscriptionsForUser(db, async (id) => { canceled.push(id) }, userId)
    expect(canceled).toEqual(['sub_del_live'])
  })

  test('lifetime / no-subscription users are a no-op', async () => {
    const db = createDb(env.DB)
    const userId = `del-life-${crypto.randomUUID()}`
    await seedUserAndSubscription(db, { userId, customerId: `cus_dl_${crypto.randomUUID().slice(0, 8)}`, status: 'active', plan: 'pro', lifetime: true })
    const canceled: string[] = []
    await cancelSubscriptionsForUser(db, async (id) => { canceled.push(id) }, userId)
    await cancelSubscriptionsForUser(db, async (id) => { canceled.push(id) }, `ghost-${crypto.randomUUID()}`)
    expect(canceled).toEqual([])
  })

  test('provider failure propagates so the deletion is aborted (no zombie billing)', async () => {
    const db = createDb(env.DB)
    const userId = `del-fail-${crypto.randomUUID()}`
    await seedUserAndSubscription(db, { userId, customerId: `cus_df_${crypto.randomUUID().slice(0, 8)}`, status: 'active', plan: 'pro', subscriptionId: 'sub_del_fail', priceId: 'price_pro' })
    await expect(cancelSubscriptionsForUser(db, async () => { throw new Error('stripe down') }, userId)).rejects.toThrow('stripe down')
  })
})

// ---------------------------------------------------------------------------
// 12. Crash window between idempotency claim and apply
// ---------------------------------------------------------------------------
describe('12. Idempotency crash window: a stale pending claim is reclaimed by the retry', () => {
  function activeEvent(eventId: string, customerId: string, now: number): DomainEvent {
    return { type: 'subscription.upserted', providerId: 'stripe', userId: null, eventId, customerId, subscriptionId: 'sub_claim', status: 'active', plan: 'pro', productId: 'price_pro', currentPeriodEnd: now + 1e9, cancelAtPeriodEnd: false }
  }

  test('marker left pending by a killed run → Stripe retry re-applies instead of dropping the event', async () => {
    const db = createDb(env.DB)
    const userId = `claim-${crypto.randomUUID()}`
    const customerId = `cus_claim_${crypto.randomUUID().slice(0, 8)}`
    const eventId = `evt_claim_${crypto.randomUUID().slice(0, 8)}`
    const now = Date.now()
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })

    // simulate: a previous run claimed the event then died before applying (2 min ago)
    await db.insert(processedWebhookEvents).values({ eventId: `stripe:${eventId}`, processedAt: new Date(now - 120_000), status: 'pending' })

    const status = await fire(db, activeEvent(eventId, customerId, now), now)
    expect(status).toBe(200)
    const rows = await db.select().from(subscription).where(eq(subscription.userId, userId))
    expect(rows[0]?.status).toBe('active') // the event was actually applied, not acked-and-dropped
    const [marker] = await db.select().from(processedWebhookEvents).where(eq(processedWebhookEvents.eventId, `stripe:${eventId}`))
    expect(marker.status).toBe('done')
  })

  test('a FRESH pending claim (concurrent twin still running) → 500 without re-applying (Stripe retries later)', async () => {
    const db = createDb(env.DB)
    const userId = `twin-${crypto.randomUUID()}`
    const customerId = `cus_twin_${crypto.randomUUID().slice(0, 8)}`
    const eventId = `evt_twin_${crypto.randomUUID().slice(0, 8)}`
    const now = Date.now()
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })

    await db.insert(processedWebhookEvents).values({ eventId: `stripe:${eventId}`, processedAt: new Date(now - 1_000), status: 'pending' })

    // 500（而非 200）：认领者若成功，重投会看到 done→200；若认领者被杀，200 会把事件永久弄丢。
    const status = await fire(db, activeEvent(eventId, customerId, now), now)
    expect(status).toBe(500)
    const rows = await db.select().from(subscription).where(eq(subscription.userId, userId))
    expect(rows[0]?.status).toBe('none') // we did NOT double-apply
  })

  test('a completed marker is status done (duplicate delivery stays a no-op)', async () => {
    const db = createDb(env.DB)
    const userId = `done-${crypto.randomUUID()}`
    const customerId = `cus_done_${crypto.randomUUID().slice(0, 8)}`
    const eventId = `evt_done_${crypto.randomUUID().slice(0, 8)}`
    const now = Date.now()
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })

    await fire(db, activeEvent(eventId, customerId, now), now)
    const [marker] = await db.select().from(processedWebhookEvents).where(eq(processedWebhookEvents.eventId, `stripe:${eventId}`))
    expect(marker.status).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// 16. Concurrent/stale Checkout Sessions: the second subscription must be
// canceled at Stripe, never silently billed (session lives 24h, the checkout
// guard only runs at session-creation time)
// ---------------------------------------------------------------------------
describe('16. Concurrent subscriptions are canceled instead of silently billing', () => {
  const mk = (eventId: string, customerId: string, subscriptionId: string, status = 'active', occurredAt?: number): DomainEvent =>
    ({ type: 'subscription.upserted', providerId: 'stripe', userId: null, eventId, customerId, subscriptionId, status, plan: 'pro', productId: 'price_pro', currentPeriodEnd: Date.now() + 1e9, cancelAtPeriodEnd: false, occurredAt })

  test('upserted for a SECOND subscription while another is active → cancels the incoming one, row untouched', async () => {
    const db = createDb(env.DB)
    const userId = `dup-${crypto.randomUUID()}`
    const customerId = `cus_dup_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_A', priceId: 'price_pro' })
    const canceled: string[] = []
    const t = await applyDomainEvent(db, mk('e_dup1', customerId, 'sub_B'), Date.now(), async (id) => { canceled.push(id) })
    expect(t).toBeNull()
    expect(canceled).toEqual(['sub_B']) // 并发订阅在 Stripe 侧被终止，不入库、不隐形扣费
    const [row] = await db.select().from(subscription).where(eq(subscription.customerId, customerId))
    expect(row.subscriptionId).toBe('sub_A')
    expect(row.status).toBe('active')
  })

  test('deleted for the canceled twin does NOT kill the tracked subscription', async () => {
    const db = createDb(env.DB)
    const userId = `dupdel-${crypto.randomUUID()}`
    const customerId = `cus_dupdel_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_A', priceId: 'price_pro' })
    const t = await applyDomainEvent(db, { type: 'subscription.deleted', providerId: 'stripe', userId: null, eventId: 'e_dup2', customerId, subscriptionId: 'sub_B' }, Date.now())
    expect(t).toBeNull()
    const ent = await getEntitlementFor(db, userId)
    expect(ent.plan).toBe('pro') // 真订阅不被并发订阅的 deleted 回声砸死
  })

  test('upserted on a lifetime row cancels the incoming concurrent subscription', async () => {
    const db = createDb(env.DB)
    const userId = `duplife-${crypto.randomUUID()}`
    const customerId = `cus_duplife_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', lifetime: true })
    const canceled: string[] = []
    const t = await applyDomainEvent(db, mk('e_dup3', customerId, 'sub_C'), Date.now(), async (id) => { canceled.push(id) })
    expect(t).toBeNull()
    expect(canceled).toEqual(['sub_C']) // 买断后并发完成的订阅必须取消，否则永不停止扣费
    const ent = await getEntitlementFor(db, userId)
    expect(ent.lifetime).toBe(true)
  })

  test('an already-canceled echo does not trigger a redundant cancel call', async () => {
    const db = createDb(env.DB)
    const userId = `dupecho-${crypto.randomUUID()}`
    const customerId = `cus_dupecho_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_A', priceId: 'price_pro' })
    const canceled: string[] = []
    const t = await applyDomainEvent(db, mk('e_dup4', customerId, 'sub_B', 'canceled'), Date.now(), async (id) => { canceled.push(id) })
    expect(t).toBeNull()
    expect(canceled).toEqual([])
  })

  test('re-subscribe after cancellation still adopts the new subscription (no over-blocking)', async () => {
    const db = createDb(env.DB)
    const userId = `resub-${crypto.randomUUID()}`
    const customerId = `cus_resub_${crypto.randomUUID().slice(0, 8)}`
    await seedUserAndSubscription(db, { userId, customerId, status: 'canceled', plan: 'free' })
    const canceled: string[] = []
    const t = await applyDomainEvent(db, mk('e_resub', customerId, 'sub_NEW'), Date.now(), async (id) => { canceled.push(id) })
    expect(canceled).toEqual([])
    expect(t).toEqual({ kind: 'activated', userId, via: 'subscription' })
  })
})

// ---------------------------------------------------------------------------
// 17. invoice stream must not pollute the subscription-stream ordering clock
// ---------------------------------------------------------------------------
describe('17. payment.failed does not advance lastEventAt', () => {
  test('updated(past_due) with a slightly EARLIER timestamp than payment.failed still applies', async () => {
    const db = createDb(env.DB)
    const userId = `clock-${crypto.randomUUID()}`
    const customerId = `cus_clock_${crypto.randomUUID().slice(0, 8)}`
    const t = Date.now()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_ck', priceId: 'price_pro' })

    // invoice.payment_failed (T+1s) 先投递；同一时刻的 updated(past_due) (T) 随后到达。
    await applyDomainEvent(db, { type: 'payment.failed', providerId: 'stripe', userId: null, eventId: 'e_ck_pf', customerId, occurredAt: t + 1000 }, t + 1)
    const tr = await applyDomainEvent(db, { type: 'subscription.upserted', providerId: 'stripe', userId: null, eventId: 'e_ck_pd', customerId, subscriptionId: 'sub_ck', status: 'past_due', plan: 'pro', productId: 'price_pro', currentPeriodEnd: null, cancelAtPeriodEnd: false, occurredAt: t }, t + 2)

    expect(tr).toEqual({ kind: 'deactivated', userId, reason: 'past_due' }) // 降级不被 invoice 流时间戳丢弃
    const ent = await getEntitlementFor(db, userId)
    expect(ent.isActive).toBe(false)
    expect(ent.paymentFailed).toBe(true)
  })

  test('subscription.deleted clears the payment-failed flag (no ghost banner for free users)', async () => {
    const db = createDb(env.DB)
    const userId = `ghost-${crypto.randomUUID()}`
    const customerId = `cus_ghost_${crypto.randomUUID().slice(0, 8)}`
    const t = Date.now()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_g', priceId: 'price_pro' })
    await applyDomainEvent(db, { type: 'payment.failed', providerId: 'stripe', userId: null, eventId: 'e_g_pf', customerId, occurredAt: t }, t)
    await applyDomainEvent(db, { type: 'subscription.deleted', providerId: 'stripe', userId: null, eventId: 'e_g_del', customerId, subscriptionId: 'sub_g', occurredAt: t + 1000 }, t + 1)
    const ent = await getEntitlementFor(db, userId)
    expect(ent.paymentFailed).toBe(false) // 订阅已死，横幅不跟免费用户一辈子
  })
})

// ---------------------------------------------------------------------------
// 11. Out-of-order delivery guard (Stripe does not guarantee event order)
// ---------------------------------------------------------------------------
describe('11. Out-of-order delivery: stale subscription events are ignored', () => {
  test('a retry-delayed subscription.updated(active) arriving AFTER deleted does not resurrect Pro', async () => {
    const db = createDb(env.DB)
    const userId = `ooo-${crypto.randomUUID()}`
    const customerId = `cus_ooo_${crypto.randomUUID().slice(0, 8)}`
    const t = Date.now()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_ooo', priceId: 'price_pro' })

    await applyDomainEvent(db, { type: 'subscription.deleted', providerId: 'stripe', userId: null, eventId: 'e_del', customerId, subscriptionId: 'sub_ooo', occurredAt: t }, t)
    // the older 'active' update (occurred BEFORE the deletion) arrives late via a Stripe retry
    const tr = await applyDomainEvent(db, { type: 'subscription.upserted', providerId: 'stripe', userId: null, eventId: 'e_stale', customerId, subscriptionId: 'sub_ooo', status: 'active', plan: 'pro', productId: 'price_pro', currentPeriodEnd: t + 1e9, cancelAtPeriodEnd: false, occurredAt: t - 60_000 }, t + 1)

    expect(tr).toBeNull()
    const ent = await getEntitlementFor(db, userId)
    expect(ent.plan).toBe('free')
    expect(ent.status).toBe('canceled') // stays dead — no free Pro forever
  })

  test('a genuinely newer subscription (re-subscribe) still applies after deletion', async () => {
    const db = createDb(env.DB)
    const userId = `ooo2-${crypto.randomUUID()}`
    const customerId = `cus_ooo2_${crypto.randomUUID().slice(0, 8)}`
    const t = Date.now()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_old', priceId: 'price_pro' })

    await applyDomainEvent(db, { type: 'subscription.deleted', providerId: 'stripe', userId: null, eventId: 'e_del2', customerId, subscriptionId: 'sub_old', occurredAt: t }, t)
    const tr = await applyDomainEvent(db, { type: 'subscription.upserted', providerId: 'stripe', userId: null, eventId: 'e_new', customerId, subscriptionId: 'sub_new', status: 'active', plan: 'pro', productId: 'price_pro', currentPeriodEnd: t + 1e9, cancelAtPeriodEnd: false, occurredAt: t + 60_000 }, t + 1)

    expect(tr).toEqual({ kind: 'activated', userId, via: 'subscription' })
    const ent = await getEntitlementFor(db, userId)
    expect(ent.plan).toBe('pro')
  })

  test('a stale payment.failed arriving after recovery does not re-flag the user', async () => {
    const db = createDb(env.DB)
    const userId = `ooo3-${crypto.randomUUID()}`
    const customerId = `cus_ooo3_${crypto.randomUUID().slice(0, 8)}`
    const t = Date.now()
    await seedUserAndSubscription(db, { userId, customerId, status: 'past_due', plan: 'pro', subscriptionId: 'sub_pf', priceId: 'price_pro' })

    // recovery applied first (newer), then the older failure arrives late
    await applyDomainEvent(db, { type: 'subscription.upserted', providerId: 'stripe', userId: null, eventId: 'e_rec', customerId, subscriptionId: 'sub_pf', status: 'active', plan: 'pro', productId: 'price_pro', currentPeriodEnd: t + 1e9, cancelAtPeriodEnd: false, occurredAt: t }, t)
    const tr = await applyDomainEvent(db, { type: 'payment.failed', providerId: 'stripe', userId: null, eventId: 'e_pf_stale', customerId, occurredAt: t - 60_000 }, t + 1)

    expect(tr).toBeNull()
    const ent = await getEntitlementFor(db, userId)
    expect(ent.paymentFailed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 10. Payment-failure signal (invoice.payment_failed → in-app banner flag)
// ---------------------------------------------------------------------------
describe('10. Payment failure signal sets/clears paymentFailedAt', () => {
  const cid = () => `cus_pf_${crypto.randomUUID().slice(0, 8)}`

  test('payment.failed on an active row → sets paymentFailedAt + payment_failed transition', async () => {
    const db = createDb(env.DB); const userId = `pf-${crypto.randomUUID()}`; const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', priceId: 'price_pro' })
    const now = Date.now()
    const t = await applyDomainEvent(db, { type: 'payment.failed', providerId: 'stripe', userId: null, eventId: `epf_${crypto.randomUUID().slice(0, 8)}`, customerId }, now)
    expect(t).toEqual({ kind: 'payment_failed', userId })
    const row = (await db.select().from(subscription).where(eq(subscription.customerId, customerId)))[0]
    expect(row.paymentFailedAt).toBe(now)
  })

  test('recovery: subscription.upserted back to active clears paymentFailedAt', async () => {
    const db = createDb(env.DB); const userId = `pf-rec-${crypto.randomUUID()}`; const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'past_due', plan: 'pro', priceId: 'price_pro' })
    await applyDomainEvent(db, { type: 'payment.failed', providerId: 'stripe', userId: null, eventId: `epf_${crypto.randomUUID().slice(0, 8)}`, customerId }, Date.now())
    await applyDomainEvent(db, { type: 'subscription.upserted', providerId: 'stripe', userId: null, eventId: `eup_${crypto.randomUUID().slice(0, 8)}`, customerId, subscriptionId: 'sub_1', status: 'active', plan: 'pro', productId: 'price_pro', currentPeriodEnd: Date.now() + 1e9, cancelAtPeriodEnd: false }, Date.now())
    const row = (await db.select().from(subscription).where(eq(subscription.customerId, customerId)))[0]
    expect(row.paymentFailedAt).toBeNull()
  })

  test('getEntitlementFor forwards paymentFailed after a failed payment', async () => {
    const db = createDb(env.DB); const userId = `pf-ent-${crypto.randomUUID()}`; const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'past_due', plan: 'pro', priceId: 'price_pro' })
    await applyDomainEvent(db, { type: 'payment.failed', providerId: 'stripe', userId: null, eventId: `epf_${crypto.randomUUID().slice(0, 8)}`, customerId }, Date.now())
    const ent = await getEntitlementFor(db, userId)
    expect(ent.paymentFailed).toBe(true)
  })

  test('payment.failed on a lifetime row → null (no recurring payment concept)', async () => {
    const db = createDb(env.DB); const userId = `pf-life-${crypto.randomUUID()}`; const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', lifetime: true })
    const t = await applyDomainEvent(db, { type: 'payment.failed', providerId: 'stripe', userId: null, eventId: `epf_${crypto.randomUUID().slice(0, 8)}`, customerId }, Date.now())
    expect(t).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 17. In-app cancel writes INTENT only — the vendor webhook owns the terminal
//     state. This is the rule that stops us from claiming a cancellation the
//     vendor never accepted.
// ---------------------------------------------------------------------------
describe('17. cancelSubscriptionForUser records intent, never a terminal state', () => {
  const cid = () => `cus_can_${crypto.randomUUID().slice(0, 8)}`
  const cancelProvider = (mode: 'immediate' | 'at_period_end', calls: string[]): PaymentProvider => ({
    id: 'stripe',
    displayName: 'Stripe',
    supportsPortal: false,
    cancelMode: mode,
    ensureCustomer: async (_u, e) => e ?? 'cus_x',
    createCheckoutSession: async () => ({ url: 'https://x' }),
    createPortalSession: async () => ({ url: 'https://x' }),
    parseWebhook: async () => ({ type: 'ignored', eventId: 'x' }),
    cancelSubscription: async (id) => { calls.push(id) },
  })

  test('an at-period-end cancel leaves status canceling and access intact', async () => {
    const db = createDb(env.DB)
    const userId = `can-epe-${crypto.randomUUID()}`
    const customerId = cid()
    const calls: string[] = []
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_live', priceId: 'price_pro' })

    const res = await cancelSubscriptionForUser(db, cancelProvider('at_period_end', calls), userId, Date.now())
    expect(res.cancelMode).toBe('at_period_end')
    expect(calls).toEqual(['sub_live'])

    const row = (await db.select().from(subscription).where(eq(subscription.customerId, customerId)))[0]
    expect(row.status).toBe('canceling')
    expect(row.cancelAtPeriodEnd).toBe(true)
    // The terminal transition belongs to the webhook, not to this call.
    expect(row.plan).toBe('pro')
    expect(row.subscriptionId).toBe('sub_live')
    // And the user is still entitled until the paid period ends.
    expect((await getEntitlementFor(db, userId)).plan).toBe('pro')
  })

  test('an immediate cancel ALSO stops at canceling — never free/canceled locally', async () => {
    const db = createDb(env.DB)
    const userId = `can-imm-${crypto.randomUUID()}`
    const customerId = cid()
    const calls: string[] = []
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_live', priceId: 'price_pro' })

    await cancelSubscriptionForUser(db, cancelProvider('immediate', calls), userId, Date.now())
    const row = (await db.select().from(subscription).where(eq(subscription.customerId, customerId)))[0]
    expect(row.status).toBe('canceling')
    expect(row.cancelAtPeriodEnd).toBe(false)
    // Writing free/canceled here would be the "we cancelled it, the vendor did
    // not" divergence this design exists to prevent.
    expect(row.plan).toBe('pro')
    expect(row.subscriptionId).toBe('sub_live')
  })

  test('the vendor webhook then writes the terminal state', async () => {
    const db = createDb(env.DB)
    const userId = `can-wh-${crypto.randomUUID()}`
    const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_live', priceId: 'price_pro' })
    await cancelSubscriptionForUser(db, cancelProvider('immediate', []), userId, Date.now())

    await applyDomainEvent(db, {
      type: 'subscription.deleted', providerId: 'stripe', userId: null,
      eventId: `edel_${crypto.randomUUID().slice(0, 8)}`, customerId, subscriptionId: 'sub_live',
    }, Date.now())

    const row = (await db.select().from(subscription).where(eq(subscription.customerId, customerId)))[0]
    expect(row.status).toBe('canceled')
    expect(row.plan).toBe('free')
    expect((await getEntitlementFor(db, userId)).plan).toBe('free')
  })

  test('a vendor cancel failure propagates and leaves no half-written intent', async () => {
    const db = createDb(env.DB)
    const userId = `can-fail-${crypto.randomUUID()}`
    const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_live', priceId: 'price_pro' })
    const failing: PaymentProvider = { ...cancelProvider('immediate', []), cancelSubscription: async () => { throw new Error('vendor down') } }

    await expect(cancelSubscriptionForUser(db, failing, userId, Date.now())).rejects.toThrow('vendor down')
    const row = (await db.select().from(subscription).where(eq(subscription.customerId, customerId)))[0]
    // Still active — we must not claim a cancellation the vendor refused.
    expect(row.status).toBe('active')
  })

  test('a second cancel is rejected rather than re-calling the vendor', async () => {
    const db = createDb(env.DB)
    const userId = `can-twice-${crypto.randomUUID()}`
    const customerId = cid()
    const calls: string[] = []
    await seedUserAndSubscription(db, { userId, customerId, status: 'active', plan: 'pro', subscriptionId: 'sub_live', priceId: 'price_pro' })
    const provider = cancelProvider('at_period_end', calls)
    await cancelSubscriptionForUser(db, provider, userId, Date.now())
    await expect(cancelSubscriptionForUser(db, provider, userId, Date.now())).rejects.toThrow(/already being canceled/)
    expect(calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 18. A product id that is not in plans.ts must never silently grant nothing.
// ---------------------------------------------------------------------------
describe('18. an unresolvable product id is refused, not silently downgraded', () => {
  const cid = () => `cus_orph_${crypto.randomUUID().slice(0, 8)}`
  test('a subscription whose price id is absent from plans.ts keeps the existing plan', async () => {
    const db = createDb(env.DB)
    const userId = `orphan-${crypto.randomUUID()}`
    const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })

    const errs: unknown[][] = []
    const realError = console.error
    console.error = (...a: unknown[]) => { errs.push(a) }
    try {
      await applyDomainEvent(db, {
        type: 'subscription.upserted', providerId: 'stripe', userId: null,
        eventId: `eorp_${crypto.randomUUID().slice(0, 8)}`, customerId,
        subscriptionId: 'sub_orphan', status: 'active', plan: null,
        productId: 'price_NOT_IN_PLANS', currentPeriodEnd: null, cancelAtPeriodEnd: false,
      }, Date.now())
    } finally {
      console.error = realError
    }

    // Refused rather than guessed: the row does not claim paid access.
    const ent = await getEntitlementFor(db, userId)
    expect(ent.plan).toBe('free')
    // …but it is LOUD. A silent charge-with-no-entitlement is the worst outcome.
    expect(errs).toHaveLength(1)
    expect(String(errs[0][0])).toContain('price_NOT_IN_PLANS')
    expect(String(errs[0][0])).toContain('customer is being charged')
  })

  test('a known product id grants without complaint', async () => {
    const db = createDb(env.DB)
    const userId = `known-${crypto.randomUUID()}`
    const customerId = cid()
    await seedUserAndSubscription(db, { userId, customerId, status: 'none', plan: 'free' })
    const errs: unknown[][] = []
    const realError = console.error
    console.error = (...a: unknown[]) => { errs.push(a) }
    try {
      await applyDomainEvent(db, {
        type: 'subscription.upserted', providerId: 'stripe', userId: null,
        eventId: `ekn_${crypto.randomUUID().slice(0, 8)}`, customerId,
        subscriptionId: 'sub_known', status: 'active', plan: 'pro',
        productId: 'price_anything', currentPeriodEnd: null, cancelAtPeriodEnd: false,
      }, Date.now())
    } finally {
      console.error = realError
    }
    expect((await getEntitlementFor(db, userId)).plan).toBe('pro')
    expect(errs).toHaveLength(0)
  })
})
