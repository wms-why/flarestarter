import { useTranslation } from '@/features/i18n/provider'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PROVIDER_CATALOG, type ProviderId } from '@/features/billing/providers/catalog'
import { formatUsd } from '@/features/billing/plans'
import type { CreditPack } from '../credit-packs'

/**
 * The pack grid. Each card shows the pack's credits and price and, when a
 * provider is on hand, a buy button. A pack with no usable provider renders
 * disabled with the operator-actionable reason (from the server fn) instead of
 * a button that would fail at checkout.
 */
export function CreditPacks({
  packs,
  providers,
  packProviderErrors,
  onBuy,
}: {
  packs: CreditPack[]
  providers: ProviderId[]
  packProviderErrors: { packId: string; errors: string[] }[]
  onBuy: (packId: string, providerId: ProviderId) => void
}) {
  const { t, locale } = useTranslation()
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {packs.map((pack) => {
        const sellable = providers.filter((id) => !!pack.productIds[id])
        const errors = packProviderErrors.find((e) => e.packId === pack.id)?.errors ?? []
        const name = pack.name[locale] ?? pack.name.en
        return (
          <Card key={pack.id} className="flex flex-col gap-4 p-[20px]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="m-0 text-[16px] font-semibold">{name}</h3>
                <p className="m-0 mt-1 text-[13px] text-fg-3">
                  {pack.credits.toLocaleString()} {t('credits.packCredits')}
                </p>
              </div>
              <span className="font-display text-[22px] font-semibold tabular-nums">{formatUsd(pack.amountUsd)}</span>
            </div>

            {sellable.length === 0 ? (
              <>
                <Badge variant="warn">{t('credits.notAvailable')}</Badge>
                {errors.length > 0 && (
                  <ul className="m-0 list-none gap-1.5 p-0 text-[12.5px] leading-snug text-destructive">
                    {errors.map((msg) => (
                      <li key={msg} className="flex gap-1.5">
                        <span aria-hidden>•</span>
                        <span>{msg}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div className="mt-auto grid gap-2">
                {sellable.map((id) => (
                  <Button key={id} className="w-full" onClick={() => onBuy(pack.id, id)}>
                    <span>{t('credits.buy')}</span>
                    <span className="text-fg-3">·</span>
                    <span className="font-mono text-[12.5px]">{PROVIDER_CATALOG[id].displayName}</span>
                  </Button>
                ))}
              </div>
            )}
          </Card>
        )
      })}
    </div>
  )
}
