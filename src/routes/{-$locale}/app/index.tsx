import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router'
import { Settings, Sparkles, ArrowRight, Coins } from 'lucide-react'
import { requireUser } from '@/features/auth/middleware'
import { getEntitlement } from '@/features/billing/middleware'
import { useTranslation } from '@/features/i18n/provider'
import { AppShell } from '@/components/app/app-shell'
import { Badge } from '@/components/ui/badge'

const rootRoute = getRouteApi('__root__')

export const Route = createFileRoute('/{-$locale}/app/')({
  validateSearch: (s: Record<string, unknown>): { checkout?: string } => ({
    checkout: typeof s.checkout === 'string' ? s.checkout : undefined,
  }),
  head: () => ({ meta: [{ name: 'robots', content: 'noindex' }] }),
  loader: async ({ params }) => {
    const [user, ent] = await Promise.all([requireUser({ data: { locale: (params as { locale?: string }).locale } }), getEntitlement()])
    return { user, ent }
  },
  component: AppHome,
})

function AppHome() {
  const { user, ent } = Route.useLoaderData()
  const { creditsEnabled } = rootRoute.useLoaderData()
  const { checkout } = Route.useSearch()
  const { t } = useTranslation()
  const isPro = ent.plan === 'pro'

  return (
    <AppShell user={user} isPro={isPro} active="dashboard" crumb={t('app.dashboard')} paymentFailed={ent.paymentFailed}>
      <div className="mb-6">
        <h1 className="page-h">{t('app.dashboard')}</h1>
        <p className="mt-1.5 text-[14.5px] text-fg-2">{t('app.welcomeSub')}</p>
      </div>

      {checkout === 'success' && ent.plan === 'free' && (
        <p className="mb-4 text-sm text-primary">{t('billing.processing')}</p>
      )}

      <div className="mb-7 flex flex-wrap items-center gap-3 text-sm text-fg-2">
        <span>{t('app.loggedInAs', { email: user.email })}</span>
        <Badge variant={isPro ? 'pro' : 'free'} dot>
          {isPro ? t('billing.pro') : t('billing.free')}
        </Badge>
      </div>

      <h2 className="mb-3.5 font-mono text-sm uppercase tracking-wide text-fg-3">{t('app.quickActions')}</h2>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Link to="/{-$locale}/app/account" className="bg-card border border-border rounded-[14px] block p-[18px] transition-colors hover:border-border-strong">
          <span className="icon-tile">
            <Settings size={20} />
          </span>
          <div className="mb-1.5 mt-3.5 flex items-center gap-2">
            <h3 className="m-0 text-[15px] font-semibold text-foreground">{t('app.openAccount')}</h3>
            <ArrowRight size={15} className="text-fg-3" />
          </div>
          <p className="m-0 text-[13px] leading-snug text-fg-3">{t('app.openAccountSub')}</p>
        </Link>
        <Link to="/{-$locale}/app/pro" className="bg-card border border-border rounded-[14px] block p-[18px] transition-colors hover:border-border-strong">
          <span className="icon-tile">
            <Sparkles size={20} />
          </span>
          <div className="mb-1.5 mt-3.5 flex items-center gap-2">
            <h3 className="m-0 text-[15px] font-semibold text-foreground">{t('app.openPro')}</h3>
            <ArrowRight size={15} className="text-fg-3" />
          </div>
          <p className="m-0 text-[13px] leading-snug text-fg-3">{t('app.openProSub')}</p>
        </Link>
        {creditsEnabled && (
          <Link to="/{-$locale}/app/credits" className="bg-card border border-border rounded-[14px] block p-[18px] transition-colors hover:border-border-strong">
            <span className="icon-tile">
              <Coins size={20} />
            </span>
            <div className="mb-1.5 mt-3.5 flex items-center gap-2">
              <h3 className="m-0 text-[15px] font-semibold text-foreground">{t('credits.nav')}</h3>
              <ArrowRight size={15} className="text-fg-3" />
            </div>
            <p className="m-0 text-[13px] leading-snug text-fg-3">{t('credits.dashboardSub')}</p>
          </Link>
        )}
      </div>
    </AppShell>
  )
}
