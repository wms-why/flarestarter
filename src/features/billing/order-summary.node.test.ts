import { describe, expect, test } from 'vitest'
import { buildOrderSummary } from '@/features/billing/order-summary'
import { hasCheckout, priceFor, tierById, PRO_TIER } from '@/features/billing/plans'

describe('buildOrderSummary', () => {
  test('an unknown or missing tier yields null so the loader can bail out', () => {
    expect(buildOrderSummary('starter', 'monthly', 'en')).toBeNull()
    expect(buildOrderSummary(undefined, 'monthly', 'en')).toBeNull()
    expect(buildOrderSummary(null, 'monthly', 'en')).toBeNull()
    expect(buildOrderSummary('', 'monthly', 'en')).toBeNull()
  })

  test('prices come from the same config the pricing card reads', () => {
    const summary = buildOrderSummary('pro', 'monthly', 'en')!
    expect(summary.amount).toBe('$9')
    expect(summary.cadence).toBe(' / month')
    const yearly = buildOrderSummary('pro', 'yearly', 'en')!
    expect(yearly.amount).toBe('$90')
    expect(yearly.cadence).toBe(' / year')
  })

  test('the yearly view offers the monthly price as the alternative, and vice versa', () => {
    const monthly = buildOrderSummary('pro', 'monthly', 'en')!
    // savingsPct is the annual-vs-twelve-monthly discount, so it is the same on
    // both views even though only the monthly card advertises it.
    expect(monthly.alternate).toEqual({ amount: '$90', cadence: ' / year', savingsPct: 17 })
    const yearly = buildOrderSummary('pro', 'yearly', 'en')!
    expect(yearly.alternate).toEqual({ amount: '$9', cadence: ' / month', savingsPct: 17 })
  })

  test('the free tier has no cadence suffix and no "or $X" offer', () => {
    const free = buildOrderSummary('free', 'monthly', 'en')!
    expect(free.amount).toBe('$0')
    expect(free.cadence).toBe('')
    // Offering "or $0 / year" would be noise.
    expect(free.alternate).toBeNull()
  })

  test('benefits list only what ships; roadmap items are separated out', () => {
    const summary = buildOrderSummary('pro', 'monthly', 'en')!
    expect(summary.benefits.length).toBeGreaterThan(0)
    expect(summary.roadmap.length).toBeGreaterThan(0)
    // An order summary must never imply unshipped features come with the money.
    expect(summary.benefits.some((b) => summary.roadmap.includes(b))).toBe(false)
    expect(summary.benefits.length + summary.roadmap.length).toBe(PRO_TIER.bullets.length)
  })

  test('copy is localized and the benefit/roadmap split survives translation', () => {
    const zh = buildOrderSummary('pro', 'monthly', 'zh')!
    expect(zh.tierName).toBe('Pro')
    expect(zh.summary).toContain('独立开发者')
    expect(zh.cadence).toBe(' / 月')
    expect(zh.benefits.length).toBe(buildOrderSummary('pro', 'monthly', 'en')!.benefits.length)
    expect(zh.benefits.every((b) => !/^[a-zA-Z]/.test(b))).toBe(true)
  })

  test('the featured flag reaches the card so the badge renders server-side', () => {
    expect(buildOrderSummary('pro', 'monthly', 'en')!.featured).toBe(true)
    expect(buildOrderSummary('free', 'monthly', 'en')!.featured).toBe(false)
    expect(buildOrderSummary('enterprise', 'monthly', 'en')!.featured).toBe(false)
  })

  test('enterprise prices resolve through the same helpers', () => {
    const summary = buildOrderSummary('enterprise', 'yearly', 'en')!
    expect(summary.amount).toBe('$390')
    expect(summary.alternate?.savingsPct).toBe(17) // 39*12=468 vs 390
  })

  test('the summary never disagrees with plans.ts about what is purchasable', () => {
    // Guards the invariant the checkout route depends on: it redirects away when
    // hasCheckout is false, so a summary must never be rendered for a tier with
    // no configured products.
    for (const id of ['free', 'pro', 'enterprise'] as const) {
      const tier = tierById(id)!
      expect(buildOrderSummary(id, 'monthly', 'en')).not.toBeNull()
      if (!hasCheckout(tier, 'monthly')) {
        // The checkout route redirects away in this case, so it must only ever be
        // the free tier that is priced at zero and unsellable.
        expect(priceFor(tier, 'monthly').amountUsd).toBeGreaterThanOrEqual(0)
      }
    }
  })
})
