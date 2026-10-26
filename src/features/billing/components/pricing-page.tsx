import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, Circle, Github } from 'lucide-react'
import { useTranslation } from '@/features/i18n/provider'
import { buttonVariants } from '@/components/ui/button'
import { PROVIDER_CATALOG, type ProviderId } from '@/features/billing/providers/catalog'
import {
  annualSavingsPct,
  formatUsd,
  hasCheckout,
  localize,
  planTiers,
  priceFor,
  tierById,
  type Interval,
  type PlanTier,
} from '@/features/billing/plans'
import type { Locale } from '@/features/i18n/locale'
import { APP_GITHUB_URL as GITHUB_URL, APP_NAME } from '@/lib/brand'

/**
 * "Accepted payment methods" strip.
 *
 * Shows the providers `BILLING_PROVIDERS` has switched on, whether or not their
 * secrets are deployed yet — it answers "what do you accept", not "what can I
 * click right now". The checkout page is the authority on the latter, so the
 * strip never has to agree with it.
 */
export function ProviderStrip({ providers, label }: { providers: ProviderId[]; label: string }) {
  if (providers.length === 0) return null
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center sm:gap-6">
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-3">{label}</span>
      <ul className="flex list-none flex-wrap items-center justify-center gap-6 p-0">
        {providers.map((id) => {
          const meta = PROVIDER_CATALOG[id]
          return (
            <li key={id} title={meta.displayName}>
              <img
                src={meta.logo}
                alt={meta.displayName}
                width={28}
                height={28}
                loading="lazy"
                className="h-7 w-auto grayscale opacity-70 transition hover:grayscale-0 hover:opacity-100"
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function IntervalToggle({
  interval,
  onChange,
  monthlyLabel,
  yearlyLabel,
}: {
  interval: Interval
  onChange: (i: Interval) => void
  monthlyLabel: string
  yearlyLabel: string
}) {
  const btn = (active: boolean) =>
    `rounded-full px-[18px] py-2 text-sm font-semibold transition-colors ${
      active ? 'bg-card text-foreground shadow-[var(--shadow-sm)]' : 'text-fg-2'
    }`
  return (
    <div className="inline-flex gap-0.5 rounded-full border border-border bg-bg-alt p-1" role="group">
      <button type="button" aria-pressed={interval === 'monthly'} onClick={() => onChange('monthly')} className={btn(interval === 'monthly')}>
        {monthlyLabel}
      </button>
      <button type="button" aria-pressed={interval === 'yearly'} onClick={() => onChange('yearly')} className={btn(interval === 'yearly')}>
        {yearlyLabel}
      </button>
    </div>
  )
}

function TierCard({
  tier,
  interval,
  locale,
  labels,
}: {
  tier: PlanTier
  interval: Interval
  locale: Locale
  labels: {
    mostPopular: string
    choose: (name: string) => string
    getStarted: string
    notOnSale: string
    perMonth: string
    perYear: string
    forever: string
  }
}) {
  const price = priceFor(tier, interval)
  const isFree = tier.id === 'free'
  const savings = annualSavingsPct(tier)
  const other: Interval = interval === 'monthly' ? 'yearly' : 'monthly'
  const otherPrice = priceFor(tier, other)
  const purchasable = hasCheckout(tier, interval)

  return (
    <div
      className="term"
      style={{
        boxShadow: tier.featured ? 'var(--shadow-lg)' : 'var(--shadow-sm)',
        borderColor: tier.featured ? 'var(--primary)' : 'var(--border)',
      }}
    >
      <div className="term-bar justify-between">
        <span className="font-mono text-xs text-fg-2">{localize(tier.name, locale)}</span>
        {tier.featured ? <span className="metric">{labels.mostPopular}</span> : null}
      </div>
      <div className="p-6 font-sans">
        <p className="m-0 mb-3.5 text-[13.5px] text-fg-3">{localize(tier.summary, locale)}</p>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[38px] font-semibold leading-none">{formatUsd(price.amountUsd)}</span>
          <span className="text-sm text-fg-3">
            {isFree ? labels.forever : interval === 'monthly' ? labels.perMonth : labels.perYear}
          </span>
        </div>
        <div className="mt-1.5 mb-5 min-h-[16px] font-mono text-xs text-fg-3">
          {!isFree && otherPrice.amountUsd > 0 && (interval === 'monthly' ? (
            savings != null ? `or ${formatUsd(otherPrice.amountUsd)} ${labels.perYear} — save ${savings}%` : null
          ) : (
            `or ${formatUsd(otherPrice.amountUsd)}${labels.perMonth}`
          ))}
        </div>

        {/*
          No provider picker here on purpose. One CTA per card goes to
          `/checkout?tier=…&interval=…`; which vendor handles the money is the
          buyer's choice, made once on the checkout page where the order summary
          is in front of them.
        */}
        {purchasable ? (
          <Link
            to="/{-$locale}/checkout"
            search={{ tier: tier.id, interval }}
            className={buttonVariants({ variant: tier.featured ? 'default' : 'outline', className: 'w-full' })}
          >
            {isFree ? labels.getStarted : labels.choose(localize(tier.name, locale))}
          </Link>
        ) : isFree && GITHUB_URL ? (
          <a href={GITHUB_URL} className={buttonVariants({ variant: 'outline', className: 'w-full' })}>
            <Github size={15} /> {labels.getStarted}
          </a>
        ) : isFree ? (
          // 免费档没有仓库 URL 可以指——留一个不可点的同款按钮，而不是 `href=""`。
          <span className={buttonVariants({ variant: 'outline', className: 'w-full' })}>
            {labels.getStarted}
          </span>
        ) : (
          /*
            No product id configured for this tier/interval, so there is nothing
            to buy. Say so rather than rendering a dead "Choose Pro" button.

            "No payment method available" would also be true here, but
            `parseEnabledProviders` treats an unset/blank BILLING_PROVIDERS as
            "all four" and never returns an empty list — so that state is
            unreachable on this page and its explanation belongs on the checkout
            page, where a *configured* provider can still be missing its secrets.
          */
          <button type="button" disabled className={buttonVariants({ variant: 'outline', className: 'w-full' })}>
            {labels.notOnSale}
          </button>
        )}

        <div className="my-5 h-px bg-border" />
        <div className="grid gap-2.5">
          {tier.bullets.map((bullet) => {
            const text = localize(bullet.text, locale)
            return bullet.enabled ? (
              <div key={text} className="flex items-start gap-2.5 text-sm text-fg-2">
                <span className="mt-0.5 shrink-0 text-primary"><Check size={16} /></span>
                {text}
              </div>
            ) : (
              <div key={text} className="flex items-start gap-2.5 text-sm text-fg-3 opacity-60">
                <span className="mt-0.5 shrink-0"><Circle size={16} /></span>
                {text}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** FAQ copy. Arrays cannot live in the i18n dictionary (it is string-valued). */
const FAQ: Record<Locale, Array<{ q: string; a: string }>> = {
  en: [
    {
      q: 'What does the free tier actually include?',
      a: 'Everything: auth, D1, KV, R2 storage, the admin console, dark mode and both languages. It is the same repository you are reading — a complete, deployable app, not a sample.',
    },
    {
      q: 'Do I need a card to start?',
      a: 'No. Clone the free tier and deploy it in one command. Nothing is metered and nothing expires.',
    },
    {
      q: 'Can I switch between monthly and yearly?',
      a: 'Yes. Cancel and re-subscribe at any time from your account page; the yearly tier is simply the discounted rate for the same access.',
    },
    {
      q: 'Which payment methods can I use?',
      a: 'Card payments through Stripe, plus Waffo Pancake, Creem and PayPal. The exact list depends on which providers the operator has switched on, and is shown on the checkout page.',
    },
    {
      q: 'Can I cancel at any time?',
      a: 'Yes. Cancelling from your account page stops future charges. Depending on the provider, access either ends at the close of the period you already paid for or immediately — the account page tells you which before you confirm.',
    },
  ],
  zh: [
    {
      q: '免费档具体包含什么？',
      a: '全部：认证、D1、KV、R2 存储、后台管理、暗色模式与中英双语。就是你正在看的这个仓库本身——一个可直接部署的完整应用，不是示例代码。',
    },
    {
      q: '开始需要绑定信用卡吗？',
      a: '不需要。克隆免费档，一条命令部署。不计量、不过期。',
    },
    {
      q: '月付和年付可以切换吗？',
      a: '可以。随时在账户页取消后重新订阅；年付就是同样权益的折扣价。',
    },
    {
      q: '支持哪些支付方式？',
      a: 'Stripe 银行卡支付，以及 Waffo Pancake、Creem 和 PayPal。具体可用列表取决于运营方启用了哪些支付服务商，会在结账页显示。',
    },
    {
      q: '可以随时取消吗？',
      a: '可以。在账户页取消即停止后续扣款。根据服务商不同，权限会在已付费周期结束后失效或立即失效——确认前账户页会明确告知。',
    },
  ],
}

export function PricingPage({
  enabledProviders,
  origin,
}: {
  enabledProviders: ProviderId[]
  origin: string
}) {
  const { t, locale } = useTranslation()
  const [interval, setInterval] = useState<Interval>('monthly')
  const freeTier = tierById('free')!

  return (
    <div className="font-sans">
      <PricingJsonLd origin={origin} />

      {/* hero */}
      <section className="grid-bg px-5 pb-10 pt-14 text-center md:px-7">
        <span className="kicker">{t('billing.pricingKicker')}</span>
        <h1 className="m-0 mb-3 mt-2.5 font-display text-[28px] font-semibold tracking-[-1px] sm:text-[36px]">
          {t('billing.pricingTitle')}
        </h1>
        <p className="mx-auto mb-5 max-w-[34em] text-base text-fg-2">{t('billing.pricingSubtitle')}</p>
        <IntervalToggle
          interval={interval}
          onChange={setInterval}
          monthlyLabel={t('billing.intervalMonthly')}
          yearlyLabel={t('billing.intervalYearly')}
        />
        <div className="mt-3 font-mono text-[12.5px] text-fg-3">{t('billing.billingNote')}</div>
      </section>

      {/* cards */}
      <section className="mx-auto grid max-w-5xl items-stretch gap-[18px] px-5 pb-2 md:grid-cols-3 md:px-7">
        {planTiers.map((tier) => (
          <TierCard
            key={tier.id}
            tier={tier}
            interval={interval}
            locale={locale}
            labels={{
              mostPopular: t('billing.mostPopular'),
              choose: (name) => t('billing.ctaChoosePlan', { name }),
              getStarted: t('billing.ctaGetStarted'),
              notOnSale: t('billing.notOnSaleCta'),
              perMonth: t('billing.perMonth'),
              perYear: t('billing.perYear'),
              forever: t('billing.forever'),
            }}
          />
        ))}
      </section>

      <p className="mt-6 text-center font-mono text-[11px] uppercase tracking-[0.16em] text-fg-3">
        {t('billing.roadmapNote')}
      </p>

      {/* providers */}
      <section className="px-5 pt-10 md:px-7">
        <ProviderStrip providers={enabledProviders} label={t('billing.providersLabel')} />
      </section>

      {/* faq */}
      <section className="grid-bg mt-10 border-t border-border px-5 py-14 md:px-7">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="m-0 font-display text-[24px] font-semibold tracking-[-0.8px] sm:text-[30px]">
            {t('billing.faqTitle')}
          </h2>
        </div>
        <div className="mx-auto mt-8 grid max-w-3xl gap-2">
          {FAQ[locale].map((item) => (
            <details key={item.q} className="term p-0">
              <summary className="cursor-pointer list-none px-[22px] py-4 text-[15px] font-semibold">
                {item.q}
              </summary>
              <div className="px-[22px] pb-[22px] pt-0 text-[14.5px] leading-relaxed text-fg-2">{item.a}</div>
            </details>
          ))}
        </div>
      </section>

      {/* the free tier keeps its own CTA strip — no provider involved */}
      <section className="px-5 pb-16 pt-10 text-center md:px-7">
        {GITHUB_URL ? (
          <a href={GITHUB_URL} className={buttonVariants({ variant: 'outline' })}>
            <Github size={15} /> {t('billing.ctaGetStarted')}
          </a>
        ) : (
          <span className={buttonVariants({ variant: 'outline' })}>{t('billing.ctaGetStarted')}</span>
        )}
        <p className="mt-4 mb-0 font-mono text-[12px] text-fg-3">
          {formatUsd(freeTier.monthly.amountUsd)} · {localize(freeTier.name, locale)}
        </p>
      </section>
    </div>
  )
}

/** Product / Offer / FAQPage structured data, derived from the same config the
 *  cards render so the two can never disagree. */
function PricingJsonLd({ origin }: { origin: string }) {
  const offers = planTiers.map((tier) => ({
    '@type': 'Offer',
    name: tier.name.en,
    price: priceFor(tier, 'monthly').amountUsd,
    priceCurrency: 'USD',
    url: `${origin}/pricing`,
    category: 'SoftwareSubscription',
  }))
  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: APP_NAME,
    description: 'Open-source Cloudflare-native SaaS starter with optional paid tiers.',
    brand: { '@type': 'Brand', name: APP_NAME },
    offers,
  }
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.en.map((i) => ({
      '@type': 'Question',
      name: i.q,
      acceptedAnswer: { '@type': 'Answer', text: i.a },
    })),
  }
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(product) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faq) }} />
    </>
  )
}
