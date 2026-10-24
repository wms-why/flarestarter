/**
 * Credit packs — the pure, client-importable side of "buy credits".
 *
 * Mirrors `plans.ts` for subscription tiers: one file answers "which pack
 * exists, how many credits, how much, and which vendor sells it under which
 * product id". An empty string means "this vendor has no product for this
 * pack yet" (the button disappears rather than erroring).
 *
 * `packForProduct` is the single authority on webhook routing: a vendor's
 * reported product id is the only thing that decides whether an inbound
 * purchase is a credit pack. Nothing in the metadata is trusted.
 */
import type { Locale } from '@/features/i18n/locale'
import { PROVIDER_IDS, type ProviderId } from '../billing/providers/catalog'

/** Localized copy, same shape as `plans.ts`'s `LocalizedText` (kept local so the
 *  pack module stays self-contained and client-importable without pulling in
 *  `plans.ts`). */
export type LocalizedText = Record<Locale, string>

export interface CreditPack {
  id: string
  name: LocalizedText
  credits: number
  /** USD。0 = 不出售。 */
  amountUsd: number
  productIds: Partial<Record<ProviderId, string>>
}

export const creditPacks: readonly CreditPack[] = [
  {
    id: 'starter',
    name: { en: 'Starter pack', zh: '入门包' },
    credits: 1_000,
    amountUsd: 5,
    productIds: { stripe: '', waffo: '', creem: '', paypal: '' },
  },
  {
    id: 'growth',
    name: { en: 'Growth pack', zh: '成长包' },
    credits: 5_000,
    amountUsd: 20,
    productIds: { stripe: '', waffo: '', creem: '', paypal: '' },
  },
  {
    id: 'scale',
    name: { en: 'Scale pack', zh: '企业包' },
    credits: 20_000,
    amountUsd: 60,
    productIds: { stripe: '', waffo: '', creem: '', paypal: '' },
  },
] as const satisfies readonly CreditPack[]

export type CreditPackId = (typeof creditPacks)[number]['id']

/** Look up a pack by its stable id. Unknown ids yield `undefined`. */
export function packById(id: string | null | undefined): CreditPack | undefined {
  if (!id) return undefined
  return creditPacks.find((pack) => pack.id === id)
}

/**
 * Reverse-resolve a vendor product id back to the credit pack it sells.
 *
 * This is the only authority on credit-pack webhook routing: the product id
 * the provider reports is authoritative, never client-supplied metadata.
 */
export function packForProduct(providerId: ProviderId, productId: string | null | undefined): CreditPack | undefined {
  if (!productId) return undefined
  return creditPacks.find((pack) => pack.productIds[providerId] === productId)
}

/** Vendors that have at least one credit-pack product configured. */
export function configuredPackProviders(): ProviderId[] {
  return PROVIDER_IDS.filter((id) => creditPacks.some((pack) => !!pack.productIds[id]))
}
