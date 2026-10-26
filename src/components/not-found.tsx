/**
 * 默认 404 页（router 的 defaultNotFoundComponent）。
 * 可能渲染在 I18nProvider / locale 布局之外，故用 locale 无关的纯文案 + 普通 <a> 回首页
 * （`/` 始终解析到默认语言；用普通 anchor 避免 typed-route 约束，404 整页跳转可接受）。
 */
import { useEffect } from 'react'
import { APP_NAME } from '@/lib/brand'

export function NotFound() {
  // document.title, not a rendered <title>: the root head() already emits one,
  // and React 19 hoisting would append a second (invalid, and browsers keep the first).
  useEffect(() => {
    document.title = `Page not found — ${APP_NAME}`
  }, [])
  return (
    <main className="grid-bg flex min-h-screen flex-col items-center justify-center gap-[18px] p-8 text-center">
      <span className="kicker">// route not found</span>
      <div className="font-display text-[120px] font-bold leading-none tracking-[-4px] text-primary">404</div>
      <h1 className="font-display text-[28px] font-semibold tracking-[-0.6px]">Page not found</h1>
      <p className="m-0 max-w-[30em] text-base leading-relaxed text-fg-2">
        This route never shipped. Check the URL or head back to safe harbor.
      </p>
      <a
        href="/"
        className="inline-flex h-13 items-center gap-2 rounded-[6px] bg-primary px-6 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
      >
        Back to home
      </a>
    </main>
  )
}
