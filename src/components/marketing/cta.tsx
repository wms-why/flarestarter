import { Link } from '@tanstack/react-router'
import { useTranslation } from '@/features/i18n/provider'
import { APP_GITHUB_URL as GITHUB_URL, APP_NAME } from '@/lib/brand'

const BTN_CLASS =
  'inline-flex h-12 shrink-0 items-center border-l border-border bg-primary px-[18px] text-[15px] font-semibold text-primary-foreground transition-colors hover:bg-primary-hover'

export function CTA({ loggedIn }: { loggedIn: boolean }) {
  const { t } = useTranslation()

  return (
    <section className="grid-bg border-t border-border px-5 md:px-7 py-14 text-center">
      <h2 className="font-display text-[28px] font-semibold tracking-[-0.6px]">{t('marketing.ctaTitle')}</h2>
      <p className="mx-auto mb-5 mt-2.5 max-w-[32em] text-[15px] text-fg-2">{t('marketing.ctaBody')}</p>
      {/* max-w-full + min-w-0 let the command scroll inside the bar instead of
          stretching it past the viewport on narrow screens */}
      <div className="inline-flex max-w-full items-center overflow-hidden rounded-md border border-border bg-card shadow-[var(--shadow-md)]">
        <span className="font-mono inline-flex h-12 min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap px-4 text-sm text-fg-2">
          <span className="text-primary">$</span>
          git clone {GITHUB_URL || `<${APP_NAME}>`}
        </span>
        {loggedIn ? (
          <Link to="/{-$locale}/app" className={BTN_CLASS}>
            {t('marketing.ctaButton')}
          </Link>
        ) : (
          <Link to="/{-$locale}/register" className={BTN_CLASS}>
            {t('marketing.ctaButton')}
          </Link>
        )}
      </div>
    </section>
  )
}
