/**
 * Pricing tiers — the single customization panel for everything plan-shaped.
 *
 * Forkers edit THIS file (plus the `billing.*` copy in the i18n dictionaries and
 * the page-level FAQ in `components/pricing-page.tsx`) to retune tiers, prices,
 * feature bullets, and which vendor sells what. Nothing else in the codebase
 * hardcodes a tier, a price, or a product id. The per-tier `credits.monthlyGrant`
 * is part of the same single customization panel: it is the allowance the
 * credits slice grants once per UTC calendar month to a subscriber on that
 * tier (admins count as enterprise).
 *
 * Pure module on purpose: no env, no SDK, no side effects. The server reads it
 * to resolve `productId → tier` on inbound webhooks; the client reads it to
 * render the pricing page and (via the checkout loader) the order summary. All
 * copy is `LocalizedText` so a tier can be rendered in either locale without a
 * parallel dictionary.
 *
 * Product ids live here rather than in env for the same reason tiers do: one
 * file answers "who can buy what, from whom, for how much". An empty string
 * means "this vendor has no product for this tier/interval yet" and makes that
 * vendor's button disappear from checkout — it is not an error.
 */
import { interpolate, type Locale } from '@/features/i18n/locale'
import { PROVIDER_IDS, type ProviderId } from './providers/catalog'

export type Interval = 'monthly' | 'yearly'

/** Paid tiers are ordered: `isAtLeastTier` compares by index in this list. */
export type Plan = 'free' | 'pro' | 'enterprise'
export const PLAN_TIER_ORDER: readonly Plan[] = ['free', 'pro', 'enterprise']

export type LocalizedText = Record<Locale, string>

export interface PlanBullet {
  text: LocalizedText
  /**
   * `false` marks copy for something not shipped yet. The pricing page renders
   * those rows muted with an empty-circle icon under the caption "gray items are
   * on the roadmap but not yet shipped"; the checkout page lists them in a
   * separate "not included yet" block so an order summary never promises them.
   */
  enabled: boolean
}

export interface PlanPrice {
  /** USD. `0` for the free tier. */
  amountUsd: number
  /** Vendor-side product id per provider. Empty string = not configured. */
  productIds: Partial<Record<ProviderId, string>>
}

export interface PlanTier {
  id: Plan
  name: LocalizedText
  summary: LocalizedText
  /** Renders the "Most popular" badge and the primary-card styling. */
  featured: boolean
  monthly: PlanPrice
  yearly: PlanPrice
  bullets: readonly PlanBullet[]
  /**
   * The monthly credit allowance granted to a subscriber on this tier, once
   * per UTC calendar month. Read by the credits slice (`monthlyGrantFor`); kept
   * here so the whole plan shape — including what a tier buys in credits — is
   * tuned from this one file.
   */
  credits: { monthlyGrant: number }
}

/** Every id a vendor must get right for the checkout buttons to work. */
const UNSET = ''

export const planTiers = [
  {
    id: 'free',
    name: { en: 'Free', zh: '免费版' },
    summary: {
      en: 'The complete Apache 2.0 template — a real, deployable app, not a teaser. Clone it and ship.',
      zh: '完整的 Apache 2.0 模板——本身就是个可部署的应用，不是半成品。克隆下来即可上线。',
    },
    featured: false,
    monthly: { amountUsd: 0, productIds: {} },
    yearly: { amountUsd: 0, productIds: {} },
    bullets: [
      { text: { en: 'Complete Apache 2.0 template', zh: '完整 Apache 2.0 模板' }, enabled: true },
      { text: { en: 'Cloudflare Workers one-command deploy', zh: '一条命令部署到 Cloudflare Workers' }, enabled: true },
      { text: { en: 'Auth, D1, KV, R2, admin console', zh: '认证、D1、KV、R2、后台管理' }, enabled: true },
      { text: { en: 'Dark mode + English / Chinese', zh: '暗色模式 + 中英双语' }, enabled: true },
      { text: { en: 'Stripe / Waffo / Creem / PayPal billing wired up', zh: '内建 Stripe / Waffo / Creem / PayPal 计费' }, enabled: true },
      { text: { en: 'Priority support', zh: '优先支持' }, enabled: false },
      { text: { en: 'Team seats', zh: '团队席位' }, enabled: false },
    ],
    credits: { monthlyGrant: 100 },
  },
  {
    id: 'pro',
    name: { en: 'Pro', zh: 'Pro' },
    summary: {
      en: 'For solo builders and small teams who want the paid modules and a direct line to the maintainers.',
      zh: '面向独立开发者和小型团队：解锁付费模块，并可直接联系维护者。',
    },
    featured: true,
    monthly: {
      amountUsd: 9,
      productIds: {
        // Previously read from STRIPE_PRICE_PRO_MONTHLY / _YEARLY. Price ids are
        // not secrets — they ship to the browser with every checkout — so they
        // live here with the rest of the plan definition.
        stripe: UNSET,
        waffo: UNSET,
        creem: UNSET,
        paypal: UNSET, // must start with `P-` (a PayPal subscription plan id)
      },
    },
    yearly: {
      amountUsd: 90,
      productIds: { stripe: UNSET, waffo: UNSET, creem: UNSET, paypal: UNSET },
    },
    bullets: [
      { text: { en: 'Everything in the Free tier', zh: '免费版的全部功能' }, enabled: true },
      { text: { en: 'The full Pro area (currently the module gallery)', zh: '完整的 Pro 区（当前是模块展馆）' }, enabled: true },
      { text: { en: 'Every future module update', zh: '所有后续模块更新' }, enabled: true },
      { text: { en: 'Priority support, straight from the maintainers', zh: '维护者直连的优先支持' }, enabled: true },
      { text: { en: 'SSO / SAML + audit log', zh: 'SSO / SAML + 审计日志' }, enabled: false },
      { text: { en: 'White-label (no {app} branding)', zh: '白标（不显示 {app} 品牌）' }, enabled: false },
    ],
    credits: { monthlyGrant: 5_000 },
  },
  {
    id: 'enterprise',
    name: { en: 'Enterprise', zh: '企业版' },
    summary: {
      en: 'For teams that need identity, auditability and an answer-on-a-SLA on top of everything in Pro.',
      zh: '在 Pro 之上补齐身份体系、可审计性与 SLA 承诺的团队方案。',
    },
    featured: false,
    monthly: {
      amountUsd: 39,
      productIds: { stripe: UNSET, waffo: UNSET, creem: UNSET, paypal: UNSET },
    },
    yearly: {
      amountUsd: 390,
      productIds: { stripe: UNSET, waffo: UNSET, creem: UNSET, paypal: UNSET },
    },
    bullets: [
      { text: { en: 'Everything in the Pro tier', zh: 'Pro 版的全部功能' }, enabled: true },
      { text: { en: 'Roadmap items, shipped first', zh: '路线图功能优先交付' }, enabled: true },
      { text: { en: 'SSO / SAML + audit log', zh: 'SSO / SAML + 审计日志' }, enabled: false },
      { text: { en: 'Team seats with role management', zh: '团队席位与角色管理' }, enabled: false },
      { text: { en: '99.9% uptime SLA', zh: '99.9% 可用性 SLA' }, enabled: false },
      { text: { en: 'White-label + shared support channel', zh: '白标 + 专属支持频道' }, enabled: false },
    ],
    credits: { monthlyGrant: 50_000 },
  },
] as const satisfies readonly PlanTier[]

/**
 * Named aliases for the canonical tiers. Prefer these over `planTiers[i]` so a
 * future reshuffle can't silently shift behavior.
 */
export const FREE_TIER = planTiers[0]
export const PRO_TIER = planTiers[1]
export const ENTERPRISE_TIER = planTiers[2]

/** Look up a tier by its stable id. Unknown ids yield `undefined` so loaders branch. */
export function tierById(id: string | null | undefined): PlanTier | undefined {
  if (!id) return undefined
  return planTiers.find((tier) => tier.id === id)
}

/** True when `actual` is the same tier as, or higher than, `required`. */
/**
 * Narrow an untrusted string (a DB column, a webhook metadata field) to a Plan.
 *
 * The entitlement layer and all three adapters need this exact test, and
 * `PLAN_TIER_ORDER` is the single definition of which ids exist — so it lives
 * here rather than being re-derived as a `Set` in five places.
 */
export function asPlan(value: unknown): Plan | null {
  return typeof value === 'string' && (PLAN_TIER_ORDER as readonly string[]).includes(value)
    ? (value as Plan)
    : null
}

export function isAtLeastTier(actual: Plan, required: Plan): boolean {
  return PLAN_TIER_ORDER.indexOf(actual) >= PLAN_TIER_ORDER.indexOf(required)
}

export function priceFor(tier: PlanTier, interval: Interval): PlanPrice {
  return interval === 'yearly' ? tier.yearly : tier.monthly
}

/**
 * Vendor ids that have at least one product configured anywhere in `planTiers`.
 *
 * Used by `env-validate` to catch the single most damaging operator mistake —
 * deploying with a provider's secrets set but every `productIds` entry still
 * empty. Nothing errors at boot, every webhook verifies fine, the pricing page
 * renders — and then a paying customer is charged and silently granted nothing,
 * because `tierForProduct` cannot resolve their price id.
 */
export function configuredProviders(): ProviderId[] {
  return PROVIDER_IDS.filter((id) => planTiers.some((tier) =>
    !!priceFor(tier, 'monthly').productIds[id] || !!priceFor(tier, 'yearly').productIds[id]))
}

/** The first `productId` entries for a provider, for log/error messages. */
export function configuredProductIds(id: ProviderId): string[] {
  return planTiers.flatMap((tier) => [priceFor(tier, 'monthly').productIds[id], priceFor(tier, 'yearly').productIds[id]])
    .filter((v): v is string => !!v)
}

/** Whether any vendor sells this tier at this interval — i.e. it has a checkout. */
export function hasCheckout(tier: PlanTier, interval: Interval): boolean {
  return Object.values(priceFor(tier, interval).productIds).some((id) => !!id)
}

/**
 * Resolve an inbound webhook's vendor product id back to the tier that sold it.
 * This is how the server turns "Creem says order PROD_X completed" into "grant
 * enterprise" without the webhook trusting anything the client sent.
 */
export function tierForProduct(providerId: ProviderId, productId: string | null | undefined): PlanTier | undefined {
  if (!productId) return undefined
  return planTiers.find((tier) => priceFor(tier, 'monthly').productIds[providerId] === productId
    || priceFor(tier, 'yearly').productIds[providerId] === productId)
}

/** `$9` / `$9.9` / `$90` — no forced decimals, matching the pricing cards. */
export function formatUsd(amountUsd: number): string {
  return `$${amountUsd.toFixed(2).replace(/\.?0+$/, '')}`
}

/**
 * Percent saved by paying yearly, or `null` when the comparison is meaningless
 * (free tier, or a yearly price that isn't actually discounted).
 */
export function annualSavingsPct(tier: PlanTier): number | null {
  const { amountUsd: monthly } = tier.monthly
  if (monthly <= 0) return null
  const full = monthly * 12
  if (tier.yearly.amountUsd <= 0 || tier.yearly.amountUsd >= full) return null
  return Math.round((1 - tier.yearly.amountUsd / full) * 100)
}

/** What the buyer actually gets — roadmap bullets deliberately excluded. */
export function includedBullets(tier: PlanTier): readonly PlanBullet[] {
  return tier.bullets.filter((b) => b.enabled)
}

/** Announced but not shipped. Kept out of the order summary's "you get" list. */
export function roadmapBullets(tier: PlanTier): readonly PlanBullet[] {
  return tier.bullets.filter((b) => !b.enabled)
}

/**
 * 取某个 locale 的文案。
 *
 * 这里额外走一次 `interpolate()` 的**全局插值**：套餐文案（`LocalizedText`）不是 i18n
 * 字典，但里面同样允许写 `{app}`（例如「白标：不显示 {app} 品牌」）。所有套餐文案
 * 都从这个函数取出，所以在这里统一解析一次就够了——不要在调用点各写各的。
 */
export function localize(text: LocalizedText, locale: Locale): string {
  return interpolate(text[locale] ?? text.en)
}

export type { ProviderId }
export { PROVIDER_IDS }
