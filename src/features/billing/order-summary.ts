import { tierById, priceFor, formatUsd, annualSavingsPct, localize, type Interval, type LocalizedText } from './plans'

/**
 * Everything the checkout page needs to describe an order, computed once on the
 * server so the component renders rather than re-derives.
 *
 * Splitting this out keeps the pricing math testable without a router, a DB, or
 * a React tree — and guarantees the price shown is the price that was charged,
 * because both come from the same `plans.ts` lookup.
 */
export interface OrderSummary {
  tierId: string
  tierName: string
  summary: string
  featured: boolean
  interval: Interval
  /** Display price for the selected interval, already formatted (`"$9"`). */
  amount: string
  /** Per-interval cadence suffix, e.g. `" / month"`. Empty for free tiers. */
  cadence: string
  /** The other interval's offer, or null when there is nothing to offer. */
  alternate: { amount: string; cadence: string; savingsPct: number | null } | null
  /** What the buyer actually gets — roadmap copy deliberately excluded. */
  benefits: string[]
  /** Announced but not shipped; shown separately so the order summary never
   *  implies these come with the purchase. */
  roadmap: string[]
}

export function buildOrderSummary(tierId: string | null | undefined, interval: Interval, locale: 'en' | 'zh'): OrderSummary | null {
  const tier = tierById(tierId)
  if (!tier) return null

  const price = priceFor(tier, interval)
  const other: Interval = interval === 'monthly' ? 'yearly' : 'monthly'
  const otherPrice = priceFor(tier, other)
  // A property of the tier, not of the selected interval: the monthly view must
  // still advertise "or $90 / year — save 17%", exactly as the pricing card does.
  const savingsPct = annualSavingsPct(tier)

  const cadence = (i: Interval): string => {
    if (tier.id === 'free') return ''
    if (i === 'monthly') return locale === 'zh' ? ' / 月' : ' / month'
    return locale === 'zh' ? ' / 年' : ' / year'
  }

  // The free tier has no interval, so offering "or $0 / year" would be noise.
  const hasAlternate = tier.id !== 'free' && otherPrice.amountUsd > 0

  return {
    tierId: tier.id,
    tierName: localize(tier.name, locale),
    summary: localize(tier.summary, locale),
    featured: tier.featured,
    interval,
    amount: formatUsd(price.amountUsd),
    cadence: cadence(interval),
    alternate: hasAlternate
      ? {
        amount: formatUsd(otherPrice.amountUsd),
        cadence: cadence(other),
        savingsPct: savingsPct,
      }
      : null,
    benefits: tier.bullets.filter((b) => b.enabled).map((b) => localize(b.text as LocalizedText, locale)),
    roadmap: tier.bullets.filter((b) => !b.enabled).map((b) => localize(b.text as LocalizedText, locale)),
  }
}
