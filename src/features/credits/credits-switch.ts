/**
 * The `CREDITS_ENABLED` switch: whether the app shows any credits surface.
 *
 * The credits slice is a *vertical* feature — it ships its own tables, server
 * functions, routes, nav entries, i18n keys and admin screen. A starter that
 * only wants subscriptions should be able to turn the whole thing off without
 * deleting files or forking the app, so every user-visible surface asks this
 * module first:
 *
 *   - the `/app/credits` and `/admin/credits` routes (404 when off),
 *   - the "Credits" nav item in the app shell and the admin group,
 *   - the quick-action card on the app dashboard,
 *   - the credits section on the account page,
 *   - the credits stat cards on the admin dashboard.
 *
 * **Default is OFF.** The switch is opt-in (`CREDITS_ENABLED=true`), matching the
 * repo rule that an unset integration degrades to off rather than surprising a
 * clone with a feature it never asked for. That also means the store — which
 * ships no product ids and therefore sells nothing out of the box — never
 * renders an empty shop by default.
 *
 * The data layer is deliberately *not* gated by this. Webhooks and the cron
 * backfill still run: if credits were ever granted while the switch was on,
 * turning it off must not strand ledger rows (a refund still has to claw back).
 * The switch governs what a human sees, not whether the books balance.
 *
 * Takes env as a parameter instead of importing `@/lib/env`, so this module
 * stays pure and node-testable (same shape as `isEmailVerificationWanted`).
 */
import { parseBoolSwitch } from '@/lib/bool-switch'

export interface CreditsEnv {
  /** Operator switch. Unset/blank = OFF. `true`/`1`/`on`/`yes` = ON. */
  CREDITS_ENABLED?: string
}

/**
 * Whether the credits UI is on.
 *
 * An unrecognised value (`ture`, `maybe`) is rejected at boot by env-validate;
 * if one ever reaches here anyway it counts as OFF — the safe direction, since
 * rendering a half-configured credits UI (no packs, no provider) is worse than
 * hiding it.
 */
export function isCreditsEnabled(e: CreditsEnv): boolean {
  return parseBoolSwitch(e.CREDITS_ENABLED) === true
}

// NOTE: this module deliberately does NOT export a helper that reads `@/lib/env`
// itself. `credits-switch` is imported by client components (the shell reads the
// flag from the root loader), and `@/lib/env` pulls in `cloudflare:workers`,
// which cannot be bundled for the browser. Server call sites therefore read env
// locally and pass it to `isCreditsEnabled(env)`.
