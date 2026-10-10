import { describe, expect, test } from 'vitest'
import {
  disabledProviderReason,
  getEnabledProviderIds,
  hasRequiredSecrets,
  listAvailableProviders,
  parseEnabledProviders,
  resolvePurchase,
  type BillingEnv,
} from '@/features/billing/providers/registry'

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

describe('parseEnabledProviders', () => {
  test('unset or empty means all four — secret gating still applies downstream', () => {
    expect(parseEnabledProviders(undefined)).toEqual(['stripe', 'waffo', 'creem', 'paypal'])
    expect(parseEnabledProviders(null)).toEqual(['stripe', 'waffo', 'creem', 'paypal'])
    expect(parseEnabledProviders('')).toEqual(['stripe', 'waffo', 'creem', 'paypal'])
    expect(parseEnabledProviders('   ')).toEqual(['stripe', 'waffo', 'creem', 'paypal'])
  })

  test('a list of only separators is a typo, not an intent to disable everything', () => {
    expect(parseEnabledProviders(',,')).toEqual(['stripe', 'waffo', 'creem', 'paypal'])
    expect(parseEnabledProviders(' , , ')).toEqual(['stripe', 'waffo', 'creem', 'paypal'])
  })

  test('trims, de-duplicates, and preserves the operator’s ordering', () => {
    expect(parseEnabledProviders('paypal, stripe ,creem')).toEqual(['paypal', 'stripe', 'creem'])
    expect(parseEnabledProviders('stripe,stripe,creem')).toEqual(['stripe', 'creem'])
  })

  test('drops unknown ids instead of crashing the page', () => {
    expect(parseEnabledProviders('stripe,paddle')).toEqual(['stripe'])
    expect(parseEnabledProviders('paddle')).toEqual(['stripe', 'waffo', 'creem', 'paypal'])
  })

  test('removing every id disables all providers', () => {
    expect(parseEnabledProviders('stripe')).toEqual(['stripe'])
  })
})

describe('hasRequiredSecrets', () => {
  test('a fully configured env satisfies all four', () => {
    for (const id of ['stripe', 'waffo', 'creem', 'paypal'] as const) {
      expect(hasRequiredSecrets(ALL_SECRETS, id), id).toBe(true)
    }
  })

  test('an empty env satisfies none', () => {
    for (const id of ['stripe', 'waffo', 'creem', 'paypal'] as const) {
      expect(hasRequiredSecrets({}, id), id).toBe(false)
    }
  })

  test('a half-configured provider is not configured', () => {
    expect(hasRequiredSecrets({ ...ALL_SECRETS, STRIPE_SECRET_KEY: undefined }, 'stripe')).toBe(false)
    expect(hasRequiredSecrets({ ...ALL_SECRETS, PAYPAL_WEBHOOK_ID: undefined }, 'paypal')).toBe(false)
  })

  test('waffo accepts either private-key encoding', () => {
    const { WAFFO_PRIVATE_KEY, ...withoutRaw } = ALL_SECRETS
    expect(hasRequiredSecrets(withoutRaw, 'waffo')).toBe(false)
    expect(hasRequiredSecrets({ ...withoutRaw, WAFFO_PRIVATE_KEY_BASE64: btoa('pem') }, 'waffo')).toBe(true)
  })

  test('whitespace-only values count as absent', () => {
    expect(hasRequiredSecrets({ ...ALL_SECRETS, CREEM_API_KEY: '  ' }, 'creem')).toBe(false)
  })
})

describe('listAvailableProviders', () => {
  test('switch and secrets both have to line up', () => {
    expect(getEnabledProviderIds({ ...ALL_SECRETS, BILLING_PROVIDERS: 'waffo,paypal' })).toEqual(['waffo', 'paypal'])
    expect(getEnabledProviderIds({ ...ALL_SECRETS, BILLING_PROVIDERS: 'waffo', CREEM_API_KEY: undefined })).toEqual(['waffo'])
    expect(getEnabledProviderIds({ ...ALL_SECRETS, BILLING_PROVIDERS: 'creem', CREEM_API_KEY: undefined })).toEqual([])
  })

  test('no secrets at all yields no providers rather than throwing', () => {
    expect(listAvailableProviders({})).toEqual([])
  })
})

describe('disabledProviderReason', () => {
  test('names the missing env vars when a switched-on provider is unconfigured', () => {
    const env: BillingEnv = { ...ALL_SECRETS, CREEM_API_KEY: undefined, CREEM_WEBHOOK_SECRET: undefined }
    const reason = disabledProviderReason(env, 'creem')
    expect(reason).toContain('CREEM_API_KEY')
    expect(reason).toContain('CREEM_WEBHOOK_SECRET')
    expect(reason).toContain('BILLING_PROVIDERS')
  })

  test('distinguishes "not switched on" from "missing secrets"', () => {
    expect(disabledProviderReason({ ...ALL_SECRETS, BILLING_PROVIDERS: 'stripe' }, 'waffo')).toContain('not listed in BILLING_PROVIDERS')
    expect(disabledProviderReason(ALL_SECRETS, 'waffo')).toBeNull()
  })

  test('waffo’s message names the alternative key encoding', () => {
    const env: BillingEnv = { ...ALL_SECRETS, WAFFO_PRIVATE_KEY: undefined }
    const reason = disabledProviderReason(env, 'waffo')
    expect(reason).toContain('WAFFO_PRIVATE_KEY_BASE64')
  })
})

describe('resolvePurchase — the single authority both paths share', () => {
  // A provider that is switched on and fully configured, but with products in
  // plans.ts. Built as a local tier so this test does not depend on the shipped
  // (empty) config staying empty.
  const tierWith = (productIds: Record<string, string>) =>
    ({ id: 'pro', name: { en: 'Pro', zh: 'Pro' }, summary: { en: '', zh: '' }, featured: true,
       monthly: { amountUsd: 9, productIds }, yearly: { amountUsd: 90, productIds }, bullets: [] }) as never

  const env: BillingEnv = { ...ALL_SECRETS, BILLING_PROVIDERS: 'stripe,waffo,creem,paypal' }

  test('a correctly configured vendor resolves to its product id', () => {
    const r = resolvePurchase(env, tierWith({ stripe: 'price_ok' }), 'monthly', 'stripe')
    expect(r).toEqual({ ok: true, productId: 'price_ok' })
  })

  test('a vendor that is switched off is refused', () => {
    const r = resolvePurchase({ ...env, BILLING_PROVIDERS: 'stripe' }, tierWith({ paypal: 'P-1' }), 'monthly', 'paypal')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('BILLING_PROVIDERS')
  })

  test('a vendor missing secrets is refused with the names of the missing vars', () => {
    const r = resolvePurchase({ ...env, CREEM_API_KEY: undefined }, tierWith({ creem: 'prod_1' }), 'monthly', 'creem')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('CREEM_API_KEY')
  })

  test('a vendor with no product for that tier is refused', () => {
    const r = resolvePurchase(env, tierWith({ stripe: '' }), 'monthly', 'stripe')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('does not sell pro')
  })

  test('a PayPal id without the P- prefix is refused HERE, not only at purchase time', () => {
    // This is the whole point of sharing the function: previously the checkout
    // page rendered a button that was guaranteed to fail on click.
    const r = resolvePurchase(env, tierWith({ paypal: 'prod_wrong' }), 'monthly', 'paypal')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('P-')
  })

  test('a correctly prefixed PayPal id resolves', () => {
    expect(resolvePurchase(env, tierWith({ paypal: 'P-ABC' }), 'monthly', 'paypal'))
      .toEqual({ ok: true, productId: 'P-ABC' })
  })
})
