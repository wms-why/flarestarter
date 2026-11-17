/**
 * The capability table.
 *
 * `supportsPortal` and `cancelMode` are user-visible promises (they pick the
 * account page button and the confirmation copy), so they are pinned here
 * rather than left to drift. Three of the five values were wrong at some point —
 * Creem shipped a portal we claimed it did not have, and Waffo's portal turned
 * out to exist but be unreachable — so the table doubles as the record of *why*
 * each vendor sits where it does.
 */
import { describe, expect, test } from 'vitest'
import { PROVIDER_CATALOG, PROVIDER_IDS, type ProviderId } from '@/features/billing/providers/catalog'

describe('catalog covers every provider', () => {
  test('PROVIDER_IDS and the catalog keys are the same set', () => {
    expect(Object.keys(PROVIDER_CATALOG).sort()).toEqual([...PROVIDER_IDS].sort())
  })

  test('every entry has something to render and something to gate on', () => {
    for (const id of PROVIDER_IDS) {
      const meta = PROVIDER_CATALOG[id]
      expect(meta.displayName.length).toBeGreaterThan(0)
      expect(meta.logo.startsWith('/billing/')).toBe(true)
      // `registry.ts` hides a provider whose secrets are all absent; an empty
      // list would make every provider look configured.
      expect(meta.requiredEnv.length).toBeGreaterThan(0)
    }
  })
})

describe('hosted portal support', () => {
  // Stripe, Dodo and Creem all mint their session per customer. Waffo could, but
  // the id it needs never reaches us; PayPal has no such API at all.
  test('exactly Stripe, Creem and Dodo have one', () => {
    const withPortal = PROVIDER_IDS.filter((id) => PROVIDER_CATALOG[id].supportsPortal)
    expect(withPortal.sort()).toEqual<ProviderId[]>(['creem', 'dodo', 'stripe'])
  })

  test('the two without one are the two we cancel in-app for', () => {
    expect(PROVIDER_CATALOG.waffo.supportsPortal).toBe(false)
    expect(PROVIDER_CATALOG.paypal.supportsPortal).toBe(false)
  })
})

describe('cancellation timing', () => {
  test('period end for Stripe / Creem / Dodo, immediate for Waffo / PayPal', () => {
    const timing = Object.fromEntries(
      PROVIDER_IDS.map((id) => [id, PROVIDER_CATALOG[id].cancelMode]),
    )
    expect(timing).toEqual({
      stripe: 'at_period_end',
      waffo: 'immediate',
      creem: 'at_period_end',
      paypal: 'immediate',
      dodo: 'at_period_end',
    } satisfies Record<ProviderId, 'immediate' | 'at_period_end'>)
  })
})

describe('env requirements stay honest', () => {
  test('a webhook secret is required by every provider that records completions', () => {
    // Not a style rule: without it the delivery cannot be verified, so a
    // checkout that trusted the provider could never be durably recorded. That
    // is exactly why `consumerKey`-only partial configs are refused.
    for (const id of PROVIDER_IDS) {
      const env = PROVIDER_CATALOG[id].requiredEnv.join(' ')
      expect(env, `${id} must gate on a webhook secret`).toMatch(/WEBHOOK_(SECRET|KEY|ID|PUBLIC_KEY)/)
    }
  })
})
