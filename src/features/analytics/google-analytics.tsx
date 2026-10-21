/**
 * Google Analytics 4 — client-side page-view tracking.
 *
 * Mounted once in the root route (`src/routes/__root.tsx`). It renders nothing:
 * it loads gtag.js and reports a `page_view` for every route change.
 *
 * Two build-time switches keep an unconfigured app completely clean:
 *   1. `vite.config.ts` swaps `ga-loader` for a no-op stub when no
 *      measurement id is set, so no GA code reaches the bundle at all;
 *   2. the guard below folds to `if (true) return`, so the stub is never even
 *      called.
 */
import { useEffect } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { GA_MEASUREMENT_ID } from '@/lib/analytics'
import { initGa, trackPageView } from '@/features/analytics/ga-loader'

export function GoogleAnalytics() {
  // `href` covers path + query changes; GA4 gets the URL from the browser
  // itself (see `trackPageView`), this is only the "something changed" signal.
  const href = useRouterState({ select: (s) => s.location.href })

  useEffect(() => {
    if (!GA_MEASUREMENT_ID) return
    initGa(GA_MEASUREMENT_ID)
    trackPageView()
  }, [href])

  return null
}
