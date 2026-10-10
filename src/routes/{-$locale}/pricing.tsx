import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { localeHead } from '@/features/seo/seo'
import { getOrigin } from '@/features/seo/seo.fns'
import { getOptionalUser } from '@/features/auth/middleware'
import { getEnabledProviders } from '@/features/billing/billing.serverfn'
import { PricingPage } from '@/features/billing/components/pricing-page'
import { SiteNav } from '@/components/marketing/site-nav'
import { Footer } from '@/components/marketing/footer'
import type { Locale } from '@/features/i18n/locale'

const rootRoute = getRouteApi('__root__')

export const Route = createFileRoute('/{-$locale}/pricing')({
  loader: async () => {
    // Which vendors are switched on — rendered as the trust strip. The checkout
    // page separately intersects this with configured secrets and the product ids
    // in plans.ts, so a listed-but-unconfigured vendor shows here and disappears
    // there. That is deliberate: the strip answers "what do you accept", the
    // chooser answers "what can I click right now".
    const [origin, user, enabledProviders] = await Promise.all([
      getOrigin(),
      getOptionalUser(),
      getEnabledProviders(),
    ])
    return { origin, loggedIn: !!user, enabledProviders }
  },
  head: ({ loaderData, params }) => {
    const origin = loaderData?.origin ?? ''
    const locale = ((params as { locale?: string }).locale ?? 'en') as Locale
    const { meta, links } = localeHead({
      origin,
      locale,
      path: '/pricing',
      title: locale === 'zh' ? '定价 — FlareStarter' : 'Pricing — FlareStarter',
      description:
        locale === 'zh'
          ? '免费开源核心，加上按月或按年的 Pro 与企业版。支持 Stripe、Waffo、Creem 与 PayPal。'
          : 'The open-source core for free, plus Pro and Enterprise by month or year. Stripe, Waffo, Creem and PayPal supported.',
    })
    return { meta, links }
  },
  component: Pricing,
})

function Pricing() {
  const { loggedIn, origin, enabledProviders } = Route.useLoaderData()
  const { theme } = rootRoute.useLoaderData()
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav theme={theme} loggedIn={loggedIn} />
      <PricingPage enabledProviders={enabledProviders} origin={origin} />
      <Footer theme={theme} />
    </div>
  )
}
