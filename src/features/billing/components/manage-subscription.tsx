import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from '@/features/i18n/provider'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { portal, cancelSubscription } from '@/features/billing/actions'
import { fmtDate } from '@/lib/format-date'
import { tierById, localize, type Plan } from '@/features/billing/plans'
import { PROVIDER_CATALOG, isProviderId, type ProviderId } from '@/features/billing/providers/catalog'

export function ManageSubscription({
  plan,
  status,
  currentPeriodEnd,
  lifetime,
  provider,
}: {
  plan: Plan
  status: string
  currentPeriodEnd?: number | null
  lifetime?: boolean
  provider?: ProviderId | null
}) {
  const { t, locale } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Clicking cancel flips this immediately; the vendor webhook owns the final
  // state and the user refreshes to see it. See billing.server.ts for why the
  // server writes `canceling` rather than a terminal status.
  const [cancelRequested, setCancelRequested] = useState(false)
  const isPaid = plan !== 'free'
  const providerMeta = provider && isProviderId(provider) ? PROVIDER_CATALOG[provider] : null
  // Plan name comes from plans.ts so the badge can never disagree with the card
  // the buyer clicked.
  const planName = localize(tierById(plan)?.name ?? { en: plan, zh: plan }, locale)

  async function manage() {
    setBusy(true)
    setError(null)
    try {
      const res = await portal()
      window.location.href = res.url
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  async function cancel() {
    if (!confirm(providerMeta?.cancelMode === 'at_period_end' ? t('billing.cancelPeriodEndHint') : t('billing.cancelImmediateHint'))) return
    setBusy(true)
    setError(null)
    try {
      await cancelSubscription()
      // No reload: the webhook has not landed yet, and reloading would throw
      // away the "cancelling" feedback the user just earned.
      setCancelRequested(true)
      setBusy(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  if (lifetime) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5 text-sm">
          <Badge variant="pro" dot>{t('billing.lifetimeOwned')}</Badge>
        </div>
        <p className="m-0 text-[13px] text-fg-3">{t('billing.lifetimeNote')}</p>
      </div>
    )
  }

  // Cancellation is in flight. The plan badge stays as-is — access continues
  // until the paid period ends — and we say plainly that the final state is
  // still on its way from the vendor.
  if (cancelRequested || status === 'canceling') {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5 text-sm">
          <Badge variant="pro" dot>{planName}</Badge>
          <span className="text-fg-3">{t('billing.status')}: {t('billing.cancelPending')}</span>
        </div>
        {currentPeriodEnd != null && (
          <p className="m-0 text-[13px] text-fg-3">
            {t('billing.renewsOn')}: {fmtDate(new Date(currentPeriodEnd))}
          </p>
        )}
        <p className="m-0 text-[13px] text-fg-3">
          {providerMeta?.cancelMode === 'at_period_end'
            ? t('billing.cancelPeriodEndHint')
            : t('billing.cancelImmediateHint')}
        </p>
        <p className="m-0 text-[13px] text-fg-3">{t('billing.cancelAwaitWebhook')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5 text-sm">
        <Badge variant={isPaid ? 'pro' : 'free'} dot>
          {planName}
        </Badge>
        <span className="text-fg-3">
          {t('billing.status')}: {status}
        </span>
        {providerMeta && (
          <span className="text-fg-3">· {t('billing.paidVia', { provider: providerMeta.displayName })}</span>
        )}
      </div>
      {isPaid && currentPeriodEnd != null && (
        <p className="m-0 text-[13px] text-fg-3">
          {/* fmtDate（UTC 确定性）：toLocaleDateString 服务端/浏览器结果不同，SSR 会 hydration mismatch */}
          {t('billing.renewsOn')}: {fmtDate(new Date(currentPeriodEnd))}
        </p>
      )}
      {error && <p className="m-0 text-sm text-destructive">{error}</p>}
      {isPaid ? (
        <div className="flex flex-wrap gap-2.5">
          {/* Stripe has a hosted portal; the other three vendors do not, so the
              same screen offers an in-app cancel instead. */}
          {providerMeta?.supportsPortal ? (
            <Button variant="outline" onClick={manage} disabled={busy}>
              {t('billing.manageSubscription')}
            </Button>
          ) : (
            <Button variant="outline" onClick={cancel} disabled={busy}>
              {t('billing.cancelSubscription')}
            </Button>
          )}
        </div>
      ) : (
        <Link to="/{-$locale}/pricing" className={buttonVariants()}>
          {t('billing.upgrade')}
        </Link>
      )}
    </div>
  )
}
