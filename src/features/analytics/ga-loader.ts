/**
 * Google Analytics 4 loader — the only module in the app that talks to Google.
 *
 * The build swaps this module for `ga-loader.stub.ts` when no measurement id
 * was configured (see `vite.config.ts`), so an unconfigured build never puts a
 * single byte of GA code into the bundle.
 *
 * The snippet mirrors Google's official gtag.js integration:
 *   https://support.google.com/analytics/answer/9539598
 */

type Gtag = (command: string, ...args: unknown[]) => void

declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: Gtag
  }
}

const SCRIPT_ID = 'ga4-loader'
const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js?id='

/** One loader per page: re-running `initGa` must not queue a second config. */
let initialized = false

/**
 * Load gtag.js and point it at `measurementId`. Idempotent — calling it again
 * (e.g. after a route change) is a no-op.
 */
export function initGa(measurementId: string): void {
  if (initialized) return
  initialized = true

  // The tag is already in the page (e.g. the dev server hot-reloaded this
  // module): don't configure it a second time.
  if (document.getElementById(SCRIPT_ID)) return

  window.dataLayer = window.dataLayer || []
  if (!window.gtag) {
    // Same shape as Google's snippet: calls are queued in dataLayer and
    // replayed by gtag.js once it arrives.
    window.gtag = function gtag(this: unknown) {
      window.dataLayer?.push(arguments)
    }
  }

  window.gtag('js', new Date())
  // `send_page_view: false` — the app sends page_view itself on every route
  // change (see `trackPageView`); otherwise the first page would be counted
  // twice (once automatically, once by us).
  window.gtag('config', measurementId, { send_page_view: false })

  const script = document.createElement('script')
  script.id = SCRIPT_ID
  script.async = true
  script.src = `${GTAG_SRC}${encodeURIComponent(measurementId)}`
  document.head.appendChild(script)
}

/**
 * Report a `page_view` for the URL the user is on right now.
 *
 * Called on every route change: GA4 has no notion of an SPA route, so without
 * this only the first page would ever be counted.
 */
export function trackPageView(): void {
  window.gtag?.('event', 'page_view', {
    page_title: document.title,
    page_location: window.location.href,
    page_path: `${window.location.pathname}${window.location.search}`,
  })
}
