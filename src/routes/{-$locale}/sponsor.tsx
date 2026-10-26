import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { localeHead } from '@/features/seo/seo'
import { getOrigin } from '@/features/seo/seo.fns'
import { SiteNav } from '@/components/marketing/site-nav'
import { Footer } from '@/components/marketing/footer'
import { SponsorPanel } from '@/features/sponsor/components/sponsor-panel'
import { SponsorsWall } from '@/features/sponsor/components/sponsors-wall'
import { getSponsorConfig, getSponsorManageLink } from '@/features/sponsor/actions'
import { useTranslation } from '@/features/i18n/provider'
import type { Locale } from '@/features/i18n/locale'
import { APP_NAME } from '@/lib/brand'

const rootRoute = getRouteApi('__root__')

export const Route = createFileRoute('/{-$locale}/sponsor')({
  validateSearch: (s: Record<string, unknown>): { status?: 'success'; session_id?: string } => ({
    status: s.status === 'success' ? 'success' : undefined,
    session_id: typeof s.session_id === 'string' ? s.session_id : undefined,
  }),
  loader: async () => {
    const origin = await getOrigin()
    const { configured, wechatEnabled, sponsors } = await getSponsorConfig()
    return { origin, configured, wechatEnabled, sponsors }
  },
  head: ({ loaderData, params }) => {
    const origin = loaderData?.origin ?? ''
    const locale = ((params as { locale?: string }).locale ?? 'en') as Locale
    const { meta, links } = localeHead({
      origin,
      locale,
      path: '/sponsor',
      title: locale === 'zh' ? `赞助 — ${APP_NAME}` : `Sponsor — ${APP_NAME}`,
      description:
        locale === 'zh'
          ? '赞助这个开源项目，一次性或按月均可。'
          : 'Sponsor this open-source project. One-time or monthly.',
    })
    return { meta, links }
  },
  component: SponsorPage,
})

function SponsorPage() {
  const { configured, wechatEnabled, sponsors } = Route.useLoaderData()
  const { status, session_id } = Route.useSearch()
  const { theme, user } = rootRoute.useLoaderData()
  const { t } = useTranslation()
  const [manageUrl, setManageUrl] = useState<string | null>(null)

  useEffect(() => {
    if (status === 'success' && session_id) {
      getSponsorManageLink({ data: { sessionId: session_id } })
        .then((r) => setManageUrl(r.url))
        .catch(() => {})
    }
  }, [status, session_id])

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav theme={theme} loggedIn={!!user} />
      <main className="mx-auto max-w-5xl px-4 py-16">
        {status === 'success' ? (
          <div className="mx-auto max-w-md rounded-xl border border-border bg-card p-8 text-center">
            <h1 className="text-2xl font-semibold">{t('sponsor.successTitle')}</h1>
            <p className="mt-2 text-fg-2">{t('sponsor.successBody')}</p>
            {manageUrl && (
              <a href={manageUrl} className="mt-4 inline-block font-mono text-sm text-primary underline">
                {t('sponsor.manageLink')}
              </a>
            )}
          </div>
        ) : (
          <>
            <div className="mx-auto max-w-2xl text-center">
              <span className="font-mono text-sm text-primary">{t('sponsor.kicker')}</span>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight">
                {(() => {
                  const title = t('sponsor.title')
                  const hl = t('sponsor.titleHl')
                  const idx = title.indexOf(hl)
                  if (idx === -1) return title
                  const before = title.slice(0, idx)
                  const after = title.slice(idx + hl.length) // 高亮词后的文字不能被截断
                  return <>{before}<span className="text-primary">{hl}</span>{after}</>
                })()}
              </h1>
              <p className="mx-auto mt-3 max-w-xl text-fg-2">{t('sponsor.subtitle')}</p>
            </div>
            <div className="mt-10">
              {configured ? (
                <SponsorPanel wechatEnabled={wechatEnabled} />
              ) : (
                <p className="text-center text-fg-3">{t('sponsor.notConfigured')}</p>
              )}
            </div>
          </>
        )}
        <SponsorsWall sponsors={sponsors} />
      </main>
      <Footer theme={theme} />
    </div>
  )
}
