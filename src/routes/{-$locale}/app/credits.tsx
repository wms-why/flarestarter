import { createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { ChevronsLeft, ChevronsRight, ChevronLeft, ChevronRight, Play } from 'lucide-react'
import { requireUser } from '@/features/auth/middleware'
import { getEntitlement } from '@/features/billing/middleware'
import { useTranslation } from '@/features/i18n/provider'
import { AppShell } from '@/components/app/app-shell'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { creditsFeatureEnabled, getCredits, consumeDemoCredits, startCreditPurchase } from '@/features/credits/credits.serverfn'
import { CreditBalanceCard } from '@/features/credits/components/credit-balance-card'
import { CreditPacks } from '@/features/credits/components/credit-packs'
import { CreditLedgerTable } from '@/features/credits/components/credit-ledger-table'
import { DEMO_TASK_COST, monthlyGrantFor } from '@/features/credits/credits.core'
import type { ProviderId } from '@/features/billing/providers/catalog'

interface CreditsSearch {
  page?: number
  pageSize?: number
  purchase?: 'success' | 'cancel'
}

export const Route = createFileRoute('/{-$locale}/app/credits')({
  validateSearch: (s: Record<string, unknown>): CreditsSearch => ({
    page: typeof s.page === 'number' ? s.page : undefined,
    pageSize: typeof s.pageSize === 'number' ? s.pageSize : undefined,
    purchase: s.purchase === 'success' || s.purchase === 'cancel' ? s.purchase : undefined,
  }),
  head: () => ({ meta: [{ name: 'robots', content: 'noindex' }] }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, params }) => {
    // Switched off → the page does not exist. 404 (not a redirect) so the URL
    // leaves no trace of a feature the operator deliberately disabled.
    if (!(await creditsFeatureEnabled())) throw notFound()
    const [user, ent, credits] = await Promise.all([
      requireUser({ data: { locale: (params as { locale?: string }).locale } }),
      getEntitlement(),
      getCredits({ data: { page: deps.page, pageSize: deps.pageSize } }),
    ])
    return { user, ent, credits }
  },
  component: CreditsPage,
})

/** Start of the next UTC calendar month (the monthly grant period). */
function nextGrantAt(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

function CreditsPage() {
  const { user, ent, credits } = Route.useLoaderData()
  const { t, locale } = useTranslation()
  const router = useRouter()
  const search = Route.useSearch()
  const { page, pageSize, purchase } = search

  const pageSizeNum = pageSize ?? 20
  const pageNum = page ?? 0
  const totalPages = Math.max(1, Math.ceil(credits.ledger.total / pageSizeNum))
  const currentPage = pageNum + 1

  const monthlyGrant = monthlyGrantFor(ent.plan === 'enterprise' ? 'enterprise' : ent.plan === 'pro' ? 'pro' : 'free')

  const [demoBusy, setDemoBusy] = useState(false)
  const [demoError, setDemoError] = useState<string | null>(null)
  const [demoDone, setDemoDone] = useState(false)

  function setSearch(patch: Partial<CreditsSearch>, replace = false) {
    void router.navigate({ to: '/{-$locale}/app/credits', search: { ...search, ...patch }, replace })
  }

  async function onBuy(packId: string, provider: ProviderId) {
    const { url } = await startCreditPurchase({ data: { packId, provider, locale } })
    window.location.href = url
  }

  async function runDemo() {
    setDemoBusy(true)
    setDemoError(null)
    setDemoDone(false)
    try {
      const res = await consumeDemoCredits()
      if (!res.ok) {
        setDemoError(t('credits.insufficient'))
        return
      }
      setDemoDone(true)
      void router.invalidate()
    } catch (err) {
      setDemoError(err instanceof Error ? err.message : String(err))
    } finally {
      setDemoBusy(false)
    }
  }

  return (
    <AppShell user={user} isPro={ent.plan === 'pro'} active="credits" crumb={t('credits.title')} paymentFailed={ent.paymentFailed}>
      <div className="mb-6">
        <h1 className="page-h">{t('credits.title')}</h1>
        <p className="mt-1.5 text-[14.5px] text-fg-2">{t('credits.dashboardSub')}</p>
      </div>

      {purchase === 'success' && <p className="mb-4 text-sm text-primary">{t('credits.purchaseSuccess')}</p>}
      {purchase === 'cancel' && <p className="mb-4 text-sm text-fg-2">{t('credits.purchaseCancel')}</p>}

      <div className="mb-7">
        <CreditBalanceCard account={credits.account} monthlyGrant={monthlyGrant} nextGrantAt={nextGrantAt(Date.now())} />
      </div>

      <section className="mb-8">
        <div className="mb-3.5 flex items-center justify-between">
          <h2 className="m-0 font-mono text-sm uppercase tracking-wide text-fg-3">{t('credits.packs')}</h2>
          <Badge variant="free">{credits.providers.length}</Badge>
        </div>
        <CreditPacks packs={credits.packs} providers={credits.providers} packProviderErrors={credits.packProviderErrors} onBuy={onBuy} />
      </section>

      <section className="mb-8">
        <Card className="overflow-hidden p-0">
          <div className="border-b border-border px-[22px] py-[18px]">
            <h2 className="m-0 text-base font-semibold">{t('credits.demoTask')}</h2>
          </div>
          <div className="p-[22px]">
            <p className="m-0 mb-4 text-[13.5px] text-fg-2">
              {t('credits.demoTaskHint', { cost: DEMO_TASK_COST })}
            </p>
            <div className="flex items-center gap-3">
              <Button onClick={runDemo} disabled={demoBusy}>
                <Play size={15} /> {t('credits.demoTask')}
              </Button>
              {demoDone && <span className="text-sm text-success">{t('credits.demoTaskDone')}</span>}
              {demoError && <span className="text-sm text-destructive">{demoError}</span>}
            </div>
          </div>
        </Card>
      </section>

      <section>
        <h2 className="mb-3.5 font-mono text-sm uppercase tracking-wide text-fg-3">{t('credits.history')}</h2>
        <Card className="overflow-hidden p-0">
          <CreditLedgerTable rows={credits.ledger.rows} />
        </Card>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <span className="font-mono text-[13px] text-fg-3">
            {t('admin.pageOf', { page: String(currentPage), total: String(totalPages) })}
          </span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={pageNum === 0} onClick={() => setSearch({ page: 0 })}><ChevronsLeft size={15} /></Button>
            <Button variant="outline" size="sm" disabled={pageNum === 0} onClick={() => setSearch({ page: pageNum - 1 })}><ChevronLeft size={15} /></Button>
            <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => setSearch({ page: pageNum + 1 })}><ChevronRight size={15} /></Button>
            <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => setSearch({ page: totalPages - 1 })}><ChevronsRight size={15} /></Button>
          </div>
        </div>
      </section>
    </AppShell>
  )
}
