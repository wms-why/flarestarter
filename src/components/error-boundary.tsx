/**
 * Default error component (router's defaultErrorComponent). Catches uncaught
 * render/loader errors so they show a styled page instead of a blank screen.
 *
 * Like NotFound, this may render outside the I18nProvider / locale layout, so
 * it uses locale-agnostic copy and a plain <a>. The raw error message is shown
 * only in dev — but note TanStack Start still serializes the error's message
 * into the dehydrated router state in the HTML, so it is visible in the page
 * source even in production. Loaders must not throw errors whose messages
 * contain secrets or internals; sanitize before throwing.
 */
import { useEffect } from 'react'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { APP_NAME } from '@/lib/brand'
// Typed against the router's own props rather than a hand-written shape: the
// router intersects these with `preload?` (ErrorRouteComponent), so the narrower
// local shape this replaced stopped satisfying the contract on a version bump.
export function ErrorPage({ error, reset }: ErrorComponentProps) {
  // Router error props are untyped by design; narrow before surfacing text.
  const message = error instanceof Error ? error.message : String(error)
  // document.title, not a rendered <title>: the root head() already emits one,
  // and React 19 hoisting would append a second (invalid, and browsers keep the first).
  useEffect(() => {
    document.title = `Something went wrong — ${APP_NAME}`
  }, [])
  return (
    <main className="grid-bg flex min-h-screen flex-col items-center justify-center gap-[18px] p-8 text-center">
      <span className="kicker">// unexpected error</span>
      <div className="font-display text-[120px] font-bold leading-none tracking-[-4px] text-primary">500</div>
      <h1 className="font-display text-[28px] font-semibold tracking-[-0.6px]">Something went wrong</h1>
      <p className="m-0 max-w-[30em] text-base leading-relaxed text-fg-2">
        An unexpected error occurred. Try again, or head back to safe harbor.
      </p>
      {import.meta.env.DEV && (
        <pre className="max-w-[40em] overflow-auto rounded-[6px] bg-bg-2 p-4 text-left text-[13px] text-fg-2">
          {message}
        </pre>
      )}
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="inline-flex h-13 items-center gap-2 rounded-[6px] border border-border px-6 text-base font-semibold transition-colors hover:bg-bg-2"
        >
          Try again
        </button>
        <a
          href="/"
          className="inline-flex h-13 items-center gap-2 rounded-[6px] bg-primary px-6 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          Back to home
        </a>
      </div>
    </main>
  )
}
