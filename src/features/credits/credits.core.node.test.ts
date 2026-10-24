/**
 * Credits core — pure logic tests (node pool, no D1).
 *
 * Covers period keys across boundaries, plan grants, upgrade proration,
 * purchase classification, and credit-pack resolution against a stub BillingEnv.
 */
import { describe, expect, test } from 'vitest'
import {
  DEMO_TASK_COST,
  classifyPurchase,
  effectivePlanForCredits,
  monthlyGrantFor,
  periodKeyFor,
  resolveCreditPack,
  upgradeDeltaFor,
} from './credits.core'
import { packById, packForProduct, configuredPackProviders, creditPacks } from './credit-packs'
import type { BillingEnv } from '../billing/providers/registry'

const ALL_SECRETS: BillingEnv = {
  STRIPE_SECRET_KEY: 'sk_test_1',
  STRIPE_WEBHOOK_SECRET: 'whsec_stripe',
  WAFFO_MERCHANT_ID: 'MER_abc',
  WAFFO_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
  WAFFO_WEBHOOK_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----',
  CREEM_API_KEY: 'creem_test_1',
  CREEM_WEBHOOK_SECRET: 'creem_secret',
  PAYPAL_CLIENT_ID: 'cid',
  PAYPAL_CLIENT_SECRET: 'csecret',
  PAYPAL_WEBHOOK_ID: 'WH-1',
}

const SECRETS_ENV: BillingEnv = { ...ALL_SECRETS, BILLING_PROVIDERS: 'stripe,waffo,creem,paypal' }

// ---------------------------------------------------------------------------
// periodKeyFor
// ---------------------------------------------------------------------------
describe('periodKeyFor', () => {
  test('a timestamp on the first of the month maps to that month', () => {
    expect(periodKeyFor(Date.UTC(2026, 9, 1, 0, 0, 0, 0))).toBe('2026-10')
  })

  test('a timestamp mid-month maps to that month', () => {
    expect(periodKeyFor(Date.UTC(2026, 9, 15, 12, 30, 0, 0))).toBe('2026-10')
  })

  test('the last millisecond of a year maps to December', () => {
    expect(periodKeyFor(Date.UTC(2025, 11, 31, 23, 59, 59, 999))).toBe('2025-12')
  })

  test('the first instant of a new year maps to January', () => {
    expect(periodKeyFor(Date.UTC(2026, 0, 1, 0, 0, 0, 0))).toBe('2026-01')
  })

  test('the day boundary rolls the key forward', () => {
    expect(periodKeyFor(Date.UTC(2026, 9, 31, 23, 59, 59, 0))).toBe('2026-10')
    expect(periodKeyFor(Date.UTC(2026, 10, 1, 0, 0, 0, 0))).toBe('2026-11')
  })

  test('is UTC, not local time', () => {
    // 2026-10-01T00:00:00Z is 08:00 on Oct 1 in Asia/Shanghai — a naive local
    // implementation would still return 2026-10 here, so check a value where
    // UTC and local month actually diverge.
    const now = Date.UTC(2026, 0, 1, 0, 0, 0, 0) // Jan 1 UTC
    expect(periodKeyFor(now)).toBe('2026-01')
  })

  test('pads single-digit months', () => {
    expect(periodKeyFor(Date.UTC(2026, 0, 5, 0, 0, 0, 0))).toBe('2026-01')
  })
})

// ---------------------------------------------------------------------------
// monthlyGrantFor
// ---------------------------------------------------------------------------
describe('monthlyGrantFor', () => {
  test('free grants 100', () => {
    expect(monthlyGrantFor('free')).toBe(100)
  })

  test('pro grants 5000', () => {
    expect(monthlyGrantFor('pro')).toBe(5_000)
  })

  test('enterprise grants 50000', () => {
    expect(monthlyGrantFor('enterprise')).toBe(50_000)
  })
})

// ---------------------------------------------------------------------------
// effectivePlanForCredits
// ---------------------------------------------------------------------------
describe('effectivePlanForCredits', () => {
  test('an admin is granted at enterprise regardless of plan', () => {
    expect(effectivePlanForCredits('admin', 'free')).toBe('enterprise')
    expect(effectivePlanForCredits('admin', 'pro')).toBe('enterprise')
  })

  test('a non-admin keeps their plan', () => {
    expect(effectivePlanForCredits(null, 'free')).toBe('free')
    expect(effectivePlanForCredits(null, 'pro')).toBe('pro')
    expect(effectivePlanForCredits('member', 'pro')).toBe('pro')
    expect(effectivePlanForCredits(undefined, 'enterprise')).toBe('enterprise')
  })
})

// ---------------------------------------------------------------------------
// upgradeDeltaFor
// ---------------------------------------------------------------------------
describe('upgradeDeltaFor', () => {
  test('nothing granted yet → the full new-tier allowance', () => {
    expect(upgradeDeltaFor(0, 'pro')).toBe(5_000)
  })

  test('partially granted → only the top-up', () => {
    expect(upgradeDeltaFor(3_000, 'pro')).toBe(2_000)
  })

  test('already granted at or above the new tier → zero', () => {
    expect(upgradeDeltaFor(5_000, 'pro')).toBe(0)
  })

  test('upgrade from pro to enterprise tops up to 50000', () => {
    expect(upgradeDeltaFor(5_000, 'enterprise')).toBe(45_000)
  })
})

// ---------------------------------------------------------------------------
// classifyPurchase
// ---------------------------------------------------------------------------
describe('classifyPurchase', () => {
  test('a configured credit-pack product id → credits with the pack', () => {
    // The shipped packs have all-empty productIds, so give the real 'starter'
    // pack a Stripe product id for this test, then restore it.
    const pack = creditPacks.find((p) => p.id === 'starter')!
    const original = pack.productIds.stripe
    pack.productIds.stripe = 'price_starter'
    try {
      expect(classifyPurchase('stripe', 'price_starter')).toEqual({ kind: 'credits', pack })
    } finally {
      pack.productIds.stripe = original
    }
  })

  test('a non-pack product id → lifetime', () => {
    expect(classifyPurchase('stripe', 'price_pro')).toEqual({ kind: 'lifetime' })
    expect(classifyPurchase('paypal', 'P-ABC')).toEqual({ kind: 'lifetime' })
  })

  test('a null or empty product id → unknown', () => {
    expect(classifyPurchase('stripe', null)).toEqual({ kind: 'unknown' })
    expect(classifyPurchase('stripe', undefined)).toEqual({ kind: 'unknown' })
    expect(classifyPurchase('stripe', '')).toEqual({ kind: 'unknown' })
  })
})

// ---------------------------------------------------------------------------
// resolveCreditPack
// ---------------------------------------------------------------------------
describe('resolveCreditPack', () => {
  const packWith = (productIds: Partial<Record<string, string>>) =>
    ({ id: 'starter', name: { en: 'Starter', zh: '入门包' }, credits: 1_000, amountUsd: 5, productIds })

  test('a disabled provider is refused with the BILLING_PROVIDERS reason', () => {
    const r = resolveCreditPack({ ...SECRETS_ENV, BILLING_PROVIDERS: 'stripe' }, packWith({ paypal: 'CRED-1' }), 'paypal')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('BILLING_PROVIDERS')
  })

  test('a provider with no secrets is refused', () => {
    // No BILLING_PROVIDERS set → all enabled, but secrets absent.
    const r = resolveCreditPack({}, packWith({ stripe: 'price_starter' }), 'stripe')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('secrets')
  })

  test('a missing product id is refused and names the pack', () => {
    const r = resolveCreditPack(SECRETS_ENV, packWith({ stripe: '' }), 'stripe')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('starter')
  })

  test('a PayPal credit-pack id starting with P- is refused', () => {
    const r = resolveCreditPack(SECRETS_ENV, packWith({ paypal: 'P-CREDITS' }), 'paypal')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('P-')
  })

  test('a valid product id resolves', () => {
    expect(resolveCreditPack(SECRETS_ENV, packWith({ stripe: 'price_starter' }), 'stripe'))
      .toEqual({ ok: true, productId: 'price_starter' })
  })
})

// ---------------------------------------------------------------------------
// DEMO_TASK_COST + pack helpers
// ---------------------------------------------------------------------------
describe('constants and pack helpers', () => {
  test('DEMO_TASK_COST is a small positive integer', () => {
    expect(DEMO_TASK_COST).toBe(5)
  })

  test('packById finds shipped packs and rejects unknown ids', () => {
    expect(packById('starter')?.credits).toBe(1_000)
    expect(packById('growth')?.credits).toBe(5_000)
    expect(packById('scale')?.credits).toBe(20_000)
    expect(packById('nope')).toBeUndefined()
    expect(packById(null)).toBeUndefined()
  })

  test('packForProduct maps configured product ids back to packs', () => {
    const pack = creditPacks.find((p) => p.id === 'growth')!
    const original = pack.productIds.stripe
    pack.productIds.stripe = 'price_growth'
    try {
      expect(packForProduct('stripe', 'price_growth')).toBe(pack)
    } finally {
      pack.productIds.stripe = original
    }
    expect(packForProduct('stripe', 'unknown')).toBeUndefined()
    expect(packForProduct('stripe', null)).toBeUndefined()
  })

  test('configuredPackProviders reflects empty shipped config', () => {
    // The shipped packs have all-empty productIds, so nothing is configured yet.
    expect(configuredPackProviders()).toEqual([])
  })
})