import { Coins } from 'lucide-react'
import { useTranslation } from '@/features/i18n/provider'
import { Card } from '@/components/ui/card'
import { fmtDate } from '@/lib/format-date'
import type { CreditAccountView } from '../credits.server'

/**
 * The headline balance card: big number, this month's grant allowance, and
 * how much of that allowance is still unspent.
 *
 * "Still unspent" is about the *monthly grant*, not the total balance: once a
 * user buys a credit pack their balance exceeds the grant, so subtracting the
 * balance from the grant would show 0 forever. The allowance left is the grant
 * minus whatever of it has been consumed, which is bounded by the balance (a
 * balance below the grant means part of the grant is already gone).
 */
export function CreditBalanceCard({
  account,
  monthlyGrant,
  nextGrantAt,
}: {
  account: CreditAccountView
  monthlyGrant: number
  nextGrantAt?: number | null
}) {
  const { t } = useTranslation()
  // The grant is consumed only after the balance drops under it; purchased
  // credits sitting on top never count as "spent allowance".
  const grantLeft = Math.min(monthlyGrant, Math.max(0, account.balance))
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-col gap-6 p-[22px] sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-fg-3">
            <Coins size={15} /> {t('credits.balance')}
          </div>
          <div className="font-display mt-1 text-[44px] font-semibold leading-none tabular-nums tracking-[-1.2px]">
            {account.balance.toLocaleString()}
          </div>
        </div>
        <dl className="grid min-w-[180px] grid-cols-2 gap-4 text-[13.5px]">
          <div>
            <dt className="text-fg-3">{t('credits.monthlyGrant')}</dt>
            <dd className="m-0 font-mono font-semibold tabular-nums">{monthlyGrant.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-fg-3">{t('credits.remaining')}</dt>
            <dd className="m-0 font-mono font-semibold tabular-nums">{grantLeft.toLocaleString()}</dd>
          </div>
          {nextGrantAt != null && (
            <div className="col-span-2">
              <dt className="text-fg-3">{t('credits.nextGrant')}</dt>
              <dd className="m-0 font-mono text-[13px]">{fmtDate(new Date(nextGrantAt))}</dd>
            </div>
          )}
        </dl>
      </div>
    </Card>
  )
}
