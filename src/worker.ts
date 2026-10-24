/**
 * Cloudflare Worker entry (wrangler `main`). Wraps the framework's default
 * server entry so every deployed response goes through cross-cutting steps:
 *   1. validate required env once per isolate (fail fast on misconfig),
 *   2. add baseline security headers, and
 *   3. report unhandled exceptions to Sentry (when SENTRY_DSN is set).
 *
 * Importing `@tanstack/react-start/server-entry` reuses the exact handler the
 * framework would otherwise run, so SSR/streaming behaviour is unchanged.
 */
import * as Sentry from '@sentry/cloudflare'
import entry from '@tanstack/react-start/server-entry'
import { withSecurityHeaders } from '@/lib/security-headers'
import { assertEnvOnce } from '@/lib/env-validate'
import { createDb } from '@/db/client'
import { runCleanup } from '@/features/maintenance/cleanup'
import { runCreditJobs } from '@/features/credits/credits.server'

const fetchHandler = (
  entry as { fetch: (request: Request, env: Cloudflare.Env, ctx: ExecutionContext) => Promise<Response> }
).fetch

const handler = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    await assertEnvOnce()
    const response = await fetchHandler(request, env, ctx)
    return withSecurityHeaders(response)
  },

  // Cron Triggers entry (schedule in wrangler.jsonc → triggers.crons). Runs the
  // maintenance cleanup and the credits backfill; extend with your own periodic
  // tasks (digests, etc.).
  async scheduled(_controller: ScheduledController, env: Cloudflare.Env, _ctx: ExecutionContext): Promise<void> {
    const db = createDb(env.DB)
    const now = Date.now()
    const result = await runCleanup(db, now)
    console.log('[cron] cleanup', result)

    // Monthly credit grants are normally issued lazily when a user's account is
    // read, so this is only a safety net for accounts nobody opens. The
    // `monthly:<userId>:<period>` idempotency key makes it a no-op for anyone
    // the lazy path already served, so daily running cannot double-grant.
    const credits = await runCreditJobs(db, now)
    console.log('[cron] credits', credits)
  },
}

// withSentry catches unhandled exceptions / promise rejections in the worker.
// Returning undefined when no DSN is set disables Sentry entirely (degrades
// gracefully). tracesSampleRate: 0 keeps it errors-only — cheap by default.
export default Sentry.withSentry(
  (env: Cloudflare.Env) =>
    env.SENTRY_DSN ? { dsn: env.SENTRY_DSN, tracesSampleRate: 0, sendDefaultPii: false } : undefined,
  handler,
)
