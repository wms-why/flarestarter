import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'
import type { Interval } from './plans'
import { isProviderId } from './providers/catalog'
import type { BillingEnv } from './providers/registry'

/** Begin a hosted checkout for a tier at an interval through one vendor. */
export const startCheckout = createServerFn({ method: 'POST' })
  .validator((d: { tier: string; interval: Interval; provider: string; locale?: string }) => d)
  .handler(async ({ data }) => {
    const { env } = await import('@/lib/env')
    const { createDb } = await import('@/db/client')
    const { readUser } = await import('@/features/auth/readUser.server')
    const { startCheckout: begin } = await import('./billing.server')
    const { tierById, hasCheckout } = await import('./plans')
    const { getBillingProvider, resolvePurchase } = await import('./providers/registry')

    const user = await readUser()
    if (!user) throw redirect({ to: '/{-$locale}/login' })

    const billingEnv = env as unknown as BillingEnv
    const tier = tierById(data.tier)
    if (!tier) throw new Error(`Unknown tier: ${data.tier}`)
    if (!isProviderId(data.provider)) throw new Error(`Unknown payment provider: ${data.provider}`)
    if (!hasCheckout(tier, data.interval)) {
      throw new Error(`${tier.id} has no ${data.interval} checkout configured`)
    }
    // The checkout page renders its buttons from `resolvePurchase` too, so the
    // verdict here and the one the buyer saw are the same computation. It is
    // still the security boundary: a hand-crafted POST cannot buy through a
    // vendor that is switched off, unconfigured, or not selling this tier.
    const resolved = resolvePurchase(billingEnv, tier, data.interval, data.provider)
    if (!resolved.ok) throw new Error(resolved.reason)
    const { productId } = resolved

    const base = new URL(env.BETTER_AUTH_URL).origin
    const locale = data.locale === 'zh' ? '/zh' : ''
    // PayPal derives its cancel URL from this one by swapping the marker, so the
    // marker must be present.
    const successUrl = `${base}${locale}/app?checkout=success`
    const cancelUrl = `${base}${locale}/checkout?tier=${tier.id}&interval=${data.interval}`

    return begin(
      createDb(env.DB),
      getBillingProvider(billingEnv, data.provider),
      user,
      productId,
      successUrl,
      cancelUrl,
      Date.now(),
      'subscription',
      tier.id,
    )
  })

export const portal = createServerFn({ method: 'POST' }).handler(async () => {
  const { env } = await import('@/lib/env')
  const { createDb } = await import('@/db/client')
  const { readUser } = await import('@/features/auth/readUser.server')
  const { openPortal, getProviderForUser } = await import('./billing.server')
  const user = await readUser()
  if (!user) throw redirect({ to: '/{-$locale}/login' })
  const provider = await getProviderForUser(createDb(env.DB), user.id)
  if (!provider?.ok) throw new Error(provider ? provider.reason : 'No subscription for this account')
  const base = new URL(env.BETTER_AUTH_URL).origin
  return openPortal(createDb(env.DB), provider.value, user.id, `${base}/app/account`)
})

/** In-app cancel for vendors without a customer portal. */
export const cancelSubscription = createServerFn({ method: 'POST' }).handler(async () => {
  const { env } = await import('@/lib/env')
  const { createDb } = await import('@/db/client')
  const { readUser } = await import('@/features/auth/readUser.server')
  const { cancelSubscriptionForUser, getProviderForUser } = await import('./billing.server')
  const user = await readUser()
  if (!user) throw redirect({ to: '/{-$locale}/login' })
  const db = createDb(env.DB)
  const provider = await getProviderForUser(db, user.id)
  if (!provider?.ok) throw new Error(provider ? provider.reason : 'No subscription for this account')
  const { cancelMode } = await cancelSubscriptionForUser(db, provider.value, user.id, Date.now())
  return { cancelMode }
})
