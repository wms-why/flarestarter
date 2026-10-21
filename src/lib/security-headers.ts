/**
 * Baseline security response headers, applied to every response by the custom
 * server entry (src/worker.ts).
 *
 * The five always-on headers are universally safe. CSP is the only one that can
 * break an app, so it's prod-only (Vite dev needs eval/ws) and deliberately
 * permissive: TanStack Start inlines a hydration <script>, and React/Tailwind
 * emit inline styles, so 'unsafe-inline' is required until you wire nonces.
 * Tightening to a nonce-based policy is the recommended next step.
 */

const BASE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // Harmless over http (browsers ignore it); enforced once served over https.
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
}

/**
 * Hosts Google Analytics 4 is allowed to use, injected at build time by
 * `vite.config.ts`. Empty unless the build ships the GA4 integration — so an
 * unconfigured build cannot talk to Google even in theory.
 */
const GA_SCRIPT_HOSTS: string[] = import.meta.env.GA_SCRIPT_HOSTS ?? []
const GA_CONNECT_HOSTS: string[] = import.meta.env.GA_CONNECT_HOSTS ?? []

/** The Google hosts a CSP has to allow for GA4 (empty = GA4 is not shipped). */
export interface GaCspHosts {
  script: string[]
  connect: string[]
}

/**
 * Build the production CSP.
 *
 * The Google hosts are only allowed when the build actually ships the GA4
 * integration (`GA_MEASUREMENT_ID`).
 */
export function buildCsp(ga: GaCspHosts = { script: [], connect: [] }): string {
  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    'https://challenges.cloudflare.com',
    'https://static.cloudflareinsights.com', // Web Analytics beacon (injected at the CF edge)
    ...ga.script,
  ]
  const connectSrc = [
    "'self'",
    'https://cloudflareinsights.com', // Web Analytics beacon POSTs
    ...ga.connect,
  ]
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`, // Turnstile + Web Analytics beacon (+ GA4 gtag.js)
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:", // blob: for client-side avatar preview; `https:` already covers GA4 image pings
    "font-src 'self' data:", // fonts are self-hosted under /fonts
    `connect-src ${connectSrc.join(' ')}`, // Web Analytics beacon POSTs (+ GA4 collection)
    "frame-src https://challenges.cloudflare.com", // Turnstile widget iframe
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

const PROD_CSP = buildCsp({ script: GA_SCRIPT_HOSTS, connect: GA_CONNECT_HOSTS })

/** Return a copy of `res` with security headers added. Leaves the body untouched (streams pass through). */
export function withSecurityHeaders(res: Response): Response {
  // Never rewrap a protocol upgrade (e.g. dev HMR websockets).
  const isUpgrade = res.status === 101 || (res as { webSocket?: unknown }).webSocket != null
  if (isUpgrade) return res

  const headers = new Headers(res.headers)
  for (const [key, value] of Object.entries(BASE_HEADERS)) headers.set(key, value)
  if (import.meta.env.PROD && !headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', PROD_CSP)
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}
