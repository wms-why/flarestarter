import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { Suspense } from 'react'
import { localeHead } from '@/features/seo/seo'
import { getOrigin } from '@/features/seo/seo.fns'
import { getOptionalUser } from '@/features/auth/middleware'
import { SiteNav } from '@/components/marketing/site-nav'
import { Footer } from '@/components/marketing/footer'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/features/i18n/provider'
import { selectChangelog, type ChangelogRaw, type ChangelogMeta } from '@/features/changelog/select'
import browserCollections from 'collections/browser'
import { dictionaries } from '@/features/i18n/locale'
import type { Locale } from '@/features/i18n/locale'
import { fmtDate } from '@/lib/format-date'
import { APP_NAME } from '@/lib/brand'

const rootRoute = getRouteApi('__root__')

const getEntries = createServerFn({ method: 'GET' })
  .validator((locale: string) => locale)
  .handler(async ({ data: locale }) => {
    const { changelog } = await import('collections/server')
    return selectChangelog(changelog as unknown as ChangelogRaw[], locale)
  })

const clientLoader = browserCollections.changelog.createClientLoader({
  id: 'changelog',
  component({ default: MDX }) {
    return <MDX />
  },
})

export const Route = createFileRoute('/{-$locale}/changelog')({
  loader: async ({ params }) => {
    const locale = ((params as { locale?: string }).locale ?? 'en') as Locale
    const [origin, user, entries] = await Promise.all([
      getOrigin(),
      getOptionalUser(),
      getEntries({ data: locale }),
    ])
    await Promise.all(entries.map((e) => clientLoader.preload(e.path)))
    return { origin, loggedIn: !!user, entries }
  },
  head: ({ loaderData, params }) => {
    const origin = loaderData?.origin ?? ''
    const locale = ((params as { locale?: string }).locale ?? 'en') as Locale
    const dict = dictionaries[locale]
    const { meta, links } = localeHead({
      origin,
      locale,
      path: '/changelog',
      title: `${dict.changelog.title} — ${APP_NAME}`,
      description: dict.changelog.subtitle,
    })
    return { meta, links }
  },
  component: Changelog,
})

function Changelog() {
  const { loggedIn, entries } = Route.useLoaderData()
  const { theme } = rootRoute.useLoaderData()
  const { t } = useTranslation()

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav theme={theme} loggedIn={loggedIn} />
      <main className="mx-auto max-w-3xl px-4 py-16">
        <header className="mb-10 text-center">
          <h1 className="text-3xl font-bold tracking-tight">{t('changelog.title')}</h1>
          <p className="mt-2 text-fg-2">{t('changelog.subtitle')}</p>
        </header>
        <div className="space-y-6">
          {entries.map((e: ChangelogMeta) => (
            <Card key={e.path}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle>{e.title}</CardTitle>
                  <Badge>{e.version}</Badge>
                </div>
                {/* fmtDate（UTC 确定性）：Intl 按浏览器时区渲染会 hydration mismatch，西时区还会差一天 */}
                <p className="text-sm text-fg-2">{fmtDate(e.date)}</p>
              </CardHeader>
              <CardContent>
                <div className="prose dark:prose-invert max-w-none">
                  <Suspense>{clientLoader.useContent(e.path)}</Suspense>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </main>
      <Footer theme={theme} />
    </div>
  )
}
