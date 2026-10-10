import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { Check, Circle, ArrowRight } from 'lucide-react'
import { useTranslation } from '@/features/i18n/provider'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { isPurchasable, getCheckoutOptions } from '@/features/billing/billing.serverfn'
import { CheckoutProviders } from '@/features/billing/components/checkout-providers'

type Search = { tier?: string; interval?: string; provider?: string }

export const Route = createFileRoute('/{-$locale}/checkout')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tier: typeof s.tier === 'string' ? s.tier : undefined,
    interval: s.interval === 'yearly' ? 'yearly' : 'monthly',
    provider: typeof s.provider === 'string' ? s.provider : undefined,
  }),
  // Per-user action page: never index it, and it is deliberately absent from the
  // sitemap's PUBLIC_PATHS.
  head: () => ({ meta: [{ name: 'robots', content: 'noindex' }] }),
  loader: async ({ params, location }) => {
    const locale = (params as { locale?: string }).locale
    const search = location.search as Search
    // Free tier (or a typo'd id) has no checkout — send them somewhere useful
    // rather than rendering an order with nothing to buy.
    if (!(await isPurchasable({ data: { tier: search.tier, interval: search.interval } }))) {
      throw redirect({ to: '/{-$locale}/register', params: locale === 'zh' ? { locale } : {} })
    }
    const options = await getCheckoutOptions({
      data: { tier: search.tier, interval: search.interval, provider: search.provider, locale },
    })
    if (!options) {
      throw redirect({ to: '/{-$locale}/pricing', params: locale === 'zh' ? { locale } : {} })
    }
    return options
  },
  component: CheckoutPage,
})

function CheckoutPage() {
  const { order, email, providers, preSelect, providerError, tierId, interval } = Route.useLoaderData()
  const { t, locale } = useTranslation()

  return (
    <div className="min-h-screen bg-background px-5 py-14 text-foreground md:px-7">
      <div className="mx-auto max-w-[560px]">
        {/* ---------- order summary ---------- */}
        <div className="term">
          <div className="term-bar justify-between">
            <span className="font-mono text-xs text-fg-2">{order.tierName}</span>
            {order.featured && <Badge variant="pro">{t('billing.mostPopular')}</Badge>}
          </div>
          <div className="p-6 font-sans">
            <p className="m-0 mb-4 text-[13.5px] text-fg-2">{order.summary}</p>

            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-[40px] font-semibold leading-none">{order.amount}</span>
              <span className="text-sm text-fg-3">{order.cadence}</span>
            </div>
            {order.alternate && (
              <p className="mt-2 mb-0 font-mono text-xs text-fg-3">
                {order.interval === 'monthly'
                  ? t('billing.altYearly', { amount: order.alternate.amount, savings: order.alternate.savingsPct ?? 0 })
                  : t('billing.altMonthly', { amount: order.alternate.amount })}
              </p>
            )}

            <div className="my-5 h-px bg-border" />

            {/* ---------- what this order actually includes ---------- */}
            <h2 className="m-0 mb-3 font-mono text-xs uppercase tracking-[0.14em] text-fg-3">
              {t('billing.orderIncludes')}
            </h2>
            <ul className="m-0 grid list-none gap-2.5 p-0">
              {order.benefits.map((b) => (
                <li key={b} className="flex items-start gap-2.5 text-sm text-fg-2">
                  <span className="mt-0.5 shrink-0 text-primary"><Check size={16} /></span>
                  {b}
                </li>
              ))}
            </ul>

            {/* Roadmap copy is listed separately and explicitly marked as not part
                of the purchase — an order summary must never imply that unshipped
                features come with the money. */}
            {order.roadmap.length > 0 && (
              <>
                <h2 className="mt-5 mb-2.5 font-mono text-xs uppercase tracking-[0.14em] text-fg-3">
                  {t('billing.roadmapLabel')}
                </h2>
                <ul className="m-0 grid list-none gap-2.5 p-0">
                  {order.roadmap.map((b) => (
                    <li key={b} className="flex items-start gap-2.5 text-sm text-fg-3">
                      <span className="mt-0.5 shrink-0 opacity-60"><Circle size={16} /></span>
                      {b}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 mb-0 font-mono text-[11px] text-fg-3">{t('billing.roadmapNotIncluded')}</p>
              </>
            )}
          </div>
        </div>

        {/* ---------- provider chooser, driven by BILLING_PROVIDERS ---------- */}
        <div className="term mt-[18px]">
          <div className="term-bar">
            <span className="font-mono text-xs text-fg-2">{t('billing.choosePayment')}</span>
          </div>
          <div className="p-6 font-sans">
            {providerError ? (
              <p className="m-0 text-sm text-destructive" role="alert">{providerError}</p>
            ) : providers.length === 0 ? (
              <div>
                <p className="m-0 text-sm text-fg-2">{t('billing.noProviderTitle')}</p>
                <p className="mt-1.5 mb-0 text-[13px] text-fg-3">{t('billing.noProviderBody')}</p>
                <Link to="/{-$locale}/pricing" className={buttonVariants({ variant: 'outline', className: 'mt-4' })}>
                  {t('billing.backToPricing')}
                </Link>
              </div>
            ) : (
              <CheckoutProviders
                providers={preSelect ? [preSelect] : providers}
                tierId={tierId}
                interval={interval}
                locale={locale === 'zh' ? 'zh' : 'en'}
                single={!!preSelect}
              />
            )}
          </div>
        </div>

        <p className="mt-4 text-center text-[13px] text-fg-3">
          {t('billing.payingAs', { email })}
          <br />
          {t('billing.paidOnProviderSite')}
        </p>
        <p className="mt-4 text-center">
          <Link to="/{-$locale}/pricing" className="inline-flex items-center gap-1.5 text-sm text-fg-2 hover:text-foreground">
            {t('billing.backToPricing')} <ArrowRight size={14} />
          </Link>
        </p>
      </div>

      <p className="mt-12 text-center font-mono text-[11px] uppercase tracking-[0.16em] text-fg-3">
        <Link to="/{-$locale}" className="hover:text-foreground">FlareStarter</Link>
      </p>
    </div>
  )
}
