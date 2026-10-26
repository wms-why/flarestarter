/**
 * Google Analytics 4 — build-time configuration.
 *
 * `GA_MEASUREMENT_ID` is resolved by Vite **at build time** (see
 * `vite.config.ts`) and inlined here as a literal. That is the whole point:
 * with an empty value the analytics loader is dead code, so the bundler drops
 * it and the shipped bundle contains no GA code at all — and the CSP never
 * has to allow Google's hosts (see `lib/security-headers.ts`).
 *
 * Why not a Cloudflare var/secret: those are only visible once the worker is
 * running, i.e. long after the bundle was built. A measurement id is public
 * anyway (it ships in the page source), so a build-time value is the right
 * home for it. Read it from the shell/CI env or a `.env` file — NOT from
 * `.dev.vars`.
 *
 * Lives in `lib/` as a dependency-free leaf so both the client component
 * (`features/analytics/`) and the server-side CSP builder can read it
 * without importing each other.
 */

/** The GA4 measurement id (e.g. `G-XXXXXXXXXX`), or `''` when not configured. */
export const GA_MEASUREMENT_ID: string = import.meta.env.GA_MEASUREMENT_ID || ''

/** True when the build was configured with a measurement id. */
export const GA_ENABLED = GA_MEASUREMENT_ID !== ''
