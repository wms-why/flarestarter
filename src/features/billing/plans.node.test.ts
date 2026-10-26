import { describe, expect, test } from 'vitest'
import {
  ENTERPRISE_TIER,
  FREE_TIER,
  PLAN_TIER_ORDER,
  PRO_TIER,
  annualSavingsPct,
  configuredProductIds,
  configuredProviders,
  formatUsd,
  hasCheckout,
  includedBullets,
  isAtLeastTier,
  localize,
  planTiers,
  priceFor,
  roadmapBullets,
  tierById,
  tierForProduct,
  type Interval,
} from '@/features/billing/plans'
import { PROVIDER_CATALOG, PROVIDER_IDS, isProviderId } from '@/features/billing/providers/catalog'

describe('planTiers config invariants', () => {
  test('every tier id is unique and PLAN_TIER_ORDER lists them all', () => {
    expect(planTiers.map((t) => t.id)).toEqual([...PLAN_TIER_ORDER])
    expect(new Set(planTiers.map((t) => t.id)).size).toBe(planTiers.length)
  })

  test('every tier carries copy in both locales', () => {
    for (const tier of planTiers) {
      for (const locale of ['en', 'zh'] as const) {
        expect(localize(tier.name, locale).length, `${tier.id}.name.${locale}`).toBeGreaterThan(0)
        expect(localize(tier.summary, locale).length, `${tier.id}.summary.${locale}`).toBeGreaterThan(0)
      }
      for (const bullet of tier.bullets) {
        expect(localize(bullet.text, 'en').length).toBeGreaterThan(0)
        expect(localize(bullet.text, 'zh').length).toBeGreaterThan(0)
      }
    }
  })

  // 套餐文案不走 i18n 字典，但它同样允许写 `{app}`（白标那条就是）。localize()
  // 负责解析；这里守住「没有任何一条套餐文案把 {app} 原样漏到界面上」。
  test('no plan copy leaks a raw {app} placeholder', () => {
    for (const tier of planTiers) {
      for (const locale of ['en', 'zh'] as const) {
        expect(localize(tier.name, locale), `${tier.id}.name.${locale}`).not.toContain('{app}')
        expect(localize(tier.summary, locale), `${tier.id}.summary.${locale}`).not.toContain('{app}')
      }
      for (const bullet of tier.bullets) {
        expect(localize(bullet.text, 'en'), bullet.text.en).not.toContain('{app}')
        expect(localize(bullet.text, 'zh'), bullet.text.zh).not.toContain('{app}')
      }
    }
  })

  test('exactly one tier is featured, and it is a paid tier', () => {
    const featured = planTiers.filter((t) => t.featured)
    expect(featured).toHaveLength(1)
    expect(featured[0].id).toBe('pro')
  })

  test('the free tier costs nothing and has no checkout', () => {
    const free = tierById('free')!
    expect(free.monthly.amountUsd).toBe(0)
    expect(free.yearly.amountUsd).toBe(0)
    expect(hasCheckout(free, 'monthly')).toBe(false)
    expect(hasCheckout(free, 'yearly')).toBe(false)
    expect(annualSavingsPct(free)).toBeNull()
  })

  test('paid tiers are cheaper yearly than twelve monthly payments', () => {
    for (const tier of [PRO_TIER, ENTERPRISE_TIER]) {
      expect(tier.yearly.amountUsd).toBeGreaterThan(0)
      expect(tier.yearly.amountUsd).toBeLessThan(tier.monthly.amountUsd * 12)
      const pct = annualSavingsPct(tier)
      expect(pct).toBeGreaterThan(0)
      expect(pct).toBeLessThanOrEqual(50)
    }
  })

  test('every tier ships at least one enabled bullet', () => {
    for (const tier of planTiers) {
      expect(includedBullets(tier).length, tier.id).toBeGreaterThan(0)
    }
  })

  test('enabled and roadmap bullets partition the list', () => {
    for (const tier of planTiers) {
      expect(includedBullets(tier).length + roadmapBullets(tier).length).toBe(tier.bullets.length)
      expect(includedBullets(tier).some((b) => !b.enabled)).toBe(false)
      expect(roadmapBullets(tier).some((b) => b.enabled)).toBe(false)
    }
  })

  test('no product id is shared by two tiers (a webhook could not tell them apart)', () => {
    const seen = new Map<string, string>()
    for (const tier of planTiers) {
      for (const interval of ['monthly', 'yearly'] as Interval[]) {
        for (const [provider, productId] of Object.entries(priceFor(tier, interval).productIds)) {
          if (!productId) continue
          const key = `${provider}:${productId}`
          expect(seen.has(key), `${key} used by both ${seen.get(key)} and ${tier.id}`).toBe(false)
          seen.set(key, tier.id)
        }
      }
    }
  })

  test('paypal product ids use the P- plan-id prefix', () => {
    // A paypal id without `P-` makes the adapter silently fall back to a
    // one-time order (and then reject the $0 amount), so the config must not
    // ship one. Placeholder ids below are the only ones a forker can set today.
    for (const tier of planTiers) {
      for (const interval of ['monthly', 'yearly'] as Interval[]) {
        const id = priceFor(tier, interval).productIds.paypal
        if (id) expect(id.startsWith('P-'), `${tier.id} paypal ${id}`).toBe(true)
      }
    }
  })
})

describe('tier lookup', () => {
  test('tierById resolves known ids and rejects everything else', () => {
    expect(tierById('pro')?.id).toBe('pro')
    expect(tierById('enterprise')?.id).toBe('enterprise')
    expect(tierById('starter')).toBeUndefined()
    expect(tierById(null)).toBeUndefined()
    expect(tierById(undefined)).toBeUndefined()
    expect(tierById('')).toBeUndefined()
  })

  test('isAtLeastTier orders free < pro < enterprise', () => {
    expect(isAtLeastTier('free', 'pro')).toBe(false)
    expect(isAtLeastTier('pro', 'free')).toBe(true)
    expect(isAtLeastTier('pro', 'pro')).toBe(true)
    expect(isAtLeastTier('enterprise', 'pro')).toBe(true)
    expect(isAtLeastTier('pro', 'enterprise')).toBe(false)
    expect(isAtLeastTier('enterprise', 'enterprise')).toBe(true)
  })
})

describe('hasCheckout', () => {
  test('is false when every product id for that interval is empty', () => {
    // The shipped config has no vendor products configured yet, so no tier has
    // a live checkout until a forker fills in plans.ts.
    for (const tier of planTiers) {
      expect(hasCheckout(tier, 'monthly')).toBe(false)
      expect(hasCheckout(tier, 'yearly')).toBe(false)
    }
  })
})

describe('tierForProduct', () => {
  test('resolves a configured product id back to its tier', () => {
    const id = PRO_TIER.monthly.productIds.stripe
    // With the shipped (empty) config nothing resolves; assert the shape rather
    // than a value that would need rewriting every time someone fills plans.ts.
    expect(tierForProduct('stripe', id)).toBe(id ? PRO_TIER : undefined)
    expect(tierForProduct('stripe', null)).toBeUndefined()
    expect(tierForProduct('stripe', '')).toBeUndefined()
    expect(tierForProduct('stripe', 'price_does_not_exist')).toBeUndefined()
  })
})

describe('formatUsd', () => {
  test('drops decimals that are not meaningful', () => {
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(9)).toBe('$9')
    expect(formatUsd(9.9)).toBe('$9.9')
    expect(formatUsd(90)).toBe('$90')
    expect(formatUsd(9.05)).toBe('$9.05')
  })
})

describe('provider catalog', () => {
  test('every provider id is a catalog key with a logo and a display name', () => {
    expect(PROVIDER_IDS).toEqual(['stripe', 'waffo', 'creem', 'paypal'])
    for (const id of PROVIDER_IDS) {
      expect(isProviderId(id)).toBe(true)
      expect(PROVIDER_CATALOG[id].displayName.length).toBeGreaterThan(0)
      expect(PROVIDER_CATALOG[id].logo).toMatch(/^\/billing\/.+\.(webp|svg|png)$/)
      expect(PROVIDER_CATALOG[id].requiredEnv.length).toBeGreaterThan(0)
    }
  })

  test('isProviderId rejects unknown values', () => {
    expect(isProviderId('stripe')).toBe(true)
    expect(isProviderId('Paddle')).toBe(false)
    expect(isProviderId(42)).toBe(false)
  })
})
describe('configuredProviders', () => {
  test('the shipped config has no products, so no vendor is configured', () => {
    // This is the state a fresh clone is in, and the one `env-validate` warns
    // about when a provider’s secrets are set but plans.ts was never filled in.
    expect(configuredProviders()).toEqual([])
    expect(configuredProductIds('stripe')).toEqual([])
  })

  test('a vendor counts as configured only when a product id is non-empty', () => {
    const withIds = { ...PRO_TIER, monthly: { ...PRO_TIER.monthly, productIds: { stripe: 'price_x', waffo: '', creem: '', paypal: '' } } }
    const tiers = [withIds, FREE_TIER, ENTERPRISE_TIER] as unknown as typeof planTiers
    const configured = PROVIDER_IDS.filter((id) =>
      tiers.some((tier) => !!priceFor(tier, 'monthly').productIds[id] || !!priceFor(tier, 'yearly').productIds[id]))
    expect(configured).toEqual(['stripe'])
  })
})
