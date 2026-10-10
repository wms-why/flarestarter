import { asPlan, isAtLeastTier, localize, tierById } from '@/features/billing/plans'
import type { Locale } from '@/features/i18n/locale'

/** Label a stored plan id using plans.ts, so the admin view can never disagree
 *  with the pricing page about what a tier is called. Unknown ids fall back to
 *  the raw value rather than being hidden. */
export function planLabel(plan: string | null | undefined, locale: Locale): string | null {
  if (!plan) return null
  const tier = tierById(plan)
  if (tier) return localize(tier.name, locale)
  return plan
}

/** True for any known paid tier, including ones above pro. */
export function isPaidPlanId(plan: string | null | undefined): boolean {
  const known = asPlan(plan)
  return known != null && isAtLeastTier(known, 'pro')
}
