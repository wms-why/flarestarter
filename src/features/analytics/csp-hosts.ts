/**
 * CSP hosts Google Analytics 4 needs.
 *
 * Source: Google's own CSP guide —
 * https://developers.google.com/tag-platform/security/guides/csp
 *
 * These are injected as build-time constants by `vite.config.ts` (they are
 * only added when the build actually ships the GA4 integration), so an
 * unconfigured build does not even carry the hostnames — its CSP has no way
 * to talk to Google.
 */

/** Where gtag.js is served from — needed in `script-src`. */
export const GA_SCRIPT_HOSTS = ['https://www.googletagmanager.com']

/**
 * Where GA4 sends its hits — needed in `connect-src`.
 *
 * `https://*.google.com` is Google's documented connect target for GA4; drop
 * it if you never touch Google Ads features and want a tighter policy.
 */
export const GA_CONNECT_HOSTS = [
  'https://www.googletagmanager.com',
  'https://*.google-analytics.com', // e.g. region1.google-analytics.com/g/collect
  'https://*.google.com',
  'https://analytics.google.com', // EU collection endpoint
]
