import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { localeHead } from '@/features/seo/seo'
import { getOrigin } from '@/features/seo/seo.fns'
import type { Locale } from '@/features/i18n/locale'
import { SiteNav } from '@/components/marketing/site-nav'
import { Hero } from '@/components/marketing/hero'
import { TechStrip } from '@/components/marketing/tech-strip'
import { Features } from '@/components/marketing/features'
import { FeatureGrid } from '@/components/marketing/feature-grid'
import { AgentSection } from '@/components/marketing/agent-section'
import { CTA } from '@/components/marketing/cta'
import { Footer } from '@/components/marketing/footer'
import { APP_NAME } from '@/lib/brand'

const rootRoute = getRouteApi('__root__')

export const Route = createFileRoute('/{-$locale}/')({
  loader: async () => ({ origin: await getOrigin() }),
  head: ({ loaderData, params }) => {
    const origin = loaderData?.origin ?? ''
    const locale = ((params as { locale?: string }).locale ?? 'en') as Locale
    const { meta, links } = localeHead({
      origin,
      locale,
      path: '/',
      title: APP_NAME,
      description:
        locale === 'zh'
          ? `${APP_NAME}——Cloudflare 原生的 SaaS 起步模板。克隆即用，部署到 Workers。`
          : `${APP_NAME} — the Cloudflare-native SaaS starter. Clone it and ship on Workers.`,
    })
    return { meta, links }
  },
  component: Home,
})

function Home() {
  const { theme, user } = rootRoute.useLoaderData()
  const loggedIn = !!user

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav theme={theme} loggedIn={loggedIn} />
      <Hero loggedIn={loggedIn} />
      <TechStrip />
      <Features />
      <FeatureGrid />
      <AgentSection />
      <CTA loggedIn={loggedIn} />
      <Footer theme={theme} />
    </div>
  )
}
