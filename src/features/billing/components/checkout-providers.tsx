import { useState } from 'react'
import { useTranslation } from '@/features/i18n/provider'
import { buttonVariants } from '@/components/ui/button'
import { PROVIDER_CATALOG, type ProviderId } from '@/features/billing/providers/catalog'
import { startCheckout } from '@/features/billing/actions'
import type { Interval } from '@/features/billing/plans'
import type { Locale } from '@/features/i18n/locale'

/**
 * The provider chooser.
 *
 * Rendered only with providers the server already approved — the loader's
 * intersection of `BILLING_PROVIDERS`, configured secrets, and the product ids
 * configured for this tier. `startCheckout` re-checks all of that server-side,
 * so this list being stale costs a clear error, never a wrong charge.
 *
 * All four vendors look the same here on purpose: a grid of logo buttons, no
 * per-vendor branching in the UI.
 */
export function CheckoutProviders({
  providers,
  tierId,
  interval,
  locale,
  single,
}: {
  providers: ProviderId[]
  tierId: string
  interval: Interval
  locale: Locale
  single: boolean
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState<ProviderId | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function pay(provider: ProviderId) {
    setBusy(provider)
    setError(null)
    try {
      const { url } = await startCheckout({ data: { tier: tierId, interval, provider, locale } })
      window.location.href = url
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(null)
    }
  }

  return (
    <div>
      {error && (
        <p className="mb-4 text-sm text-destructive" role="alert">{error}</p>
      )}
      <div className={single ? 'grid gap-2.5' : 'grid grid-cols-1 gap-2.5 sm:grid-cols-2'}>
        {providers.map((id) => {
          const meta = PROVIDER_CATALOG[id]
          const loading = busy === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => pay(id)}
              disabled={busy != null}
              className={buttonVariants({ variant: 'outline', className: 'h-[52px] w-full justify-between gap-3' })}
            >
              <span className="flex items-center gap-2.5">
                <img
                  src={meta.logo}
                  alt=""
                  aria-hidden
                  width={22}
                  height={22}
                  className="size-[22px] shrink-0 opacity-80"
                />
                <span className="font-medium">{meta.displayName}</span>
              </span>
              {loading && <span className="font-mono text-[11px] uppercase tracking-wider">{t('billing.processing')}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
