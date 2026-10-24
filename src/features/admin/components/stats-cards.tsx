import { Users, Activity, CreditCard, BadgeCheck, Coins } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { useTranslation } from '@/features/i18n/provider'
import type { AdminStats } from '@/features/admin/middleware'

export function StatsCards({ stats }: { stats: AdminStats }) {
  const { t } = useTranslation()
  const subs = stats.subscriptions
  const planTotal = subs.pro + subs.free
  const proPct = planTotal ? Math.round((subs.pro / planTotal) * 100) : 0

  const cards = [
    { Icon: Users, label: t('admin.totalUsers'), value: stats.totalUsers },
    { Icon: Activity, label: t('admin.activeUsers'), value: stats.activeUsers },
    { Icon: CreditCard, label: t('admin.pro'), value: subs.pro },
    { Icon: BadgeCheck, label: t('admin.activeSubs'), value: subs.active },
  ]

  return (
    <div className="grid gap-3.5">
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {cards.map(({ Icon, label, value }) => (
          <Card key={label} className="rounded-xl px-5 py-[18px]">
            <div className="flex items-center gap-2 text-[13px] text-fg-3">
              <Icon size={16} /> {label}
            </div>
            <div className="font-display text-[30px] font-semibold tabular-nums tracking-[-0.8px] my-2 mb-1">
              {value.toLocaleString()}
            </div>
          </Card>
        ))}
      </div>

      {/* credits: its own full-width row of three cards — not nested inside the
          two-column grid below, which would squeeze three cards into one cell.
          Absent entirely when the credits feature is switched off. */}
      {stats.credits && (
      <div className="grid gap-3.5 sm:grid-cols-3">
          {[
            { Icon: Coins, label: t('credits.balance'), value: stats.credits.outstanding },
            { Icon: Activity, label: t('credits.lifetimePurchased'), value: stats.credits.issued },
            { Icon: Activity, label: t('credits.lifetimeConsumed'), value: stats.credits.consumed },
          ].map(({ Icon, label, value }) => (
            <Card key={label} className="rounded-xl px-5 py-[18px]">
              <div className="flex items-center gap-2 text-[13px] text-fg-3">
                <Icon size={16} /> {label}
              </div>
              <div className="font-display text-[30px] font-semibold tabular-nums tracking-[-0.8px] my-2 mb-1">
                {value.toLocaleString()}
              </div>
            </Card>
          ))}
      </div>
      )}

      <div className="grid gap-3.5 md:grid-cols-2">
        {/* plan split donut (real pro/free counts) */}
        <Card className="p-5">
          <h3 className="m-0 mb-4 text-[15px] font-semibold">{t('admin.subscriptions')}</h3>
          <div className="flex items-center gap-4">
            {planTotal ? (
              <div
                className="h-24 w-24 shrink-0 rounded-full"
                style={{ background: `conic-gradient(var(--primary) 0 ${proPct}%, var(--soft) ${proPct}% 100%)` }}
                role="img"
                aria-label={`${t('admin.pro')} ${proPct}%`}
              />
            ) : (
              <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full border border-dashed border-border font-mono text-sm text-fg-3">
                0
              </div>
            )}
            <div className="grid gap-2.5 text-[13.5px]">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--primary)' }} />
                {t('admin.pro')} · {subs.pro}
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--soft)' }} />
                {t('admin.free')} · {subs.free}
              </div>
            </div>
          </div>
        </Card>

        {/* status breakdown (real) */}
        <Card className="p-5">
          <h3 className="m-0 mb-4 text-[15px] font-semibold">{t('admin.status')}</h3>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-fg-3">{t('admin.active')}</dt>
            <dd className="text-right font-mono font-semibold tabular-nums">{subs.active}</dd>
            <dt className="text-fg-3">{t('admin.pastDue')}</dt>
            <dd className="text-right font-mono font-semibold tabular-nums">{subs.pastDue}</dd>
            <dt className="text-fg-3">{t('admin.canceled')}</dt>
            <dd className="text-right font-mono font-semibold tabular-nums">{subs.canceled}</dd>
          </dl>
        </Card>
      </div>
    </div>
  )
}
