import { Link } from '@tanstack/react-router'
import { ArrowRight, Terminal } from 'lucide-react'
import { useTranslation } from '@/features/i18n/provider'
import { buttonVariants } from '@/components/ui/button'
import { APP_GITHUB_URL as GITHUB_URL, APP_NAME } from '@/lib/brand'

function TerminalCard() {
  return (
    <div className="term">
      <div className="term-bar">
        <span className="term-dot" style={{ background: '#FF5F57' }} />
        <span className="term-dot" style={{ background: '#FEBC2E' }} />
        <span className="term-dot" style={{ background: '#28C840' }} />
        <span className="ml-2 text-xs text-fg-3">zsh — my-app</span>
      </div>
      <div className="term-body">
        <div>
          {/* 没有仓库 URL 时别渲染出「git clone」加两个空格的悬空命令 */}
          <span className="pr">$</span> git clone {GITHUB_URL || `<${APP_NAME}>`} my-app
        </div>
        <div className="mt-1.5">
          <span className="pr">$</span> cd my-app && pnpm install
        </div>
        <div className="ok mt-1.5">✓ auth · billing · admin · i18n</div>
        <div className="ok">✓ D1 + KV wired</div>
        <div className="mt-1.5">
          <span className="pr">$</span> pnpm dev
        </div>
        <div>
          <span className="ok">✓</span> <span className="pr">http://localhost:3000</span>
        </div>
        <div className="mt-1.5">
          <span className="pr">$</span> <span className="term-cursor" />
        </div>
      </div>
    </div>
  )
}

export function Hero({ loggedIn }: { loggedIn: boolean }) {
  const { t } = useTranslation()

  return (
    <section className="grid-bg grid items-center gap-9 px-5 md:px-7 py-14 md:grid-cols-2">
      <div className="flex flex-col gap-[18px]">
        <span className="kicker">// cloudflare-native saas starter</span>
        <h1 className="font-display text-[34px] font-semibold leading-[1.08] tracking-[-1.2px] sm:text-[42px]">
          {t('marketing.heroTitlePre')}
          <span className="text-primary">{t('marketing.heroTitleHl')}</span>
          {t('marketing.heroTitlePost')}
        </h1>
        <p className="m-0 max-w-[34em] text-base leading-relaxed text-fg-2">
          {t('marketing.heroSubtitle')}
        </p>
        <div className="mt-1 flex flex-wrap gap-2.5">
          {loggedIn ? (
            <Link to="/{-$locale}/app" className={buttonVariants({ size: 'lg' })}>
              {t('marketing.heroCtaPrimary')} <ArrowRight size={18} />
            </Link>
          ) : (
            <Link to="/{-$locale}/register" className={buttonVariants({ size: 'lg' })}>
              {t('marketing.heroCtaPrimary')} <ArrowRight size={18} />
            </Link>
          )}
          {GITHUB_URL && (
            <a
              href={GITHUB_URL}
              className={buttonVariants({ variant: 'outline', size: 'lg', className: 'font-mono text-sm' })}
            >
              <Terminal size={16} /> {t('marketing.gitClone')}
            </a>
          )}
        </div>
      </div>
      <TerminalCard />
    </section>
  )
}
