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
 *   - the credits stat cards on the admin dashboard,
 *   - **every credits server fn** (via `assertCreditsEnabled`, see below).
 *
 * Hiding a surface is necessary but not sufficient: a server fn is reachable
 * directly, so each one asserts the switch itself. Adding a new credits server
 * fn means calling `assertCreditsEnabled` as its first statement — the rule is
 * also recorded in AGENTS.md.
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

/**
 * Throw unless the credits UI is on — the guard every credits server fn calls
 * before touching the DB.
 *
 * **Why hiding is not enough.** A server fn is a network endpoint: hiding a
 * section only stops the *rendered* button. A hand-crafted POST or a client
 * that still holds a stale bundle can call `consumeDemoCredits` /
 * `getCredits` / the admin ledger reads with the switch off. Those would then
 * create a `credit_account` row for a user whose app has no credits at all,
 * and hand out ledger data from a feature the operator deliberately removed.
 *
 * It lives here rather than in each handler so the rule is one function, and
 * takes the already-read env so it stays pure (see the module header: client
 * components import this file and must not pull in `@/lib/env`).
 *
 * The error is a plain `Error`, not a redirect: the UI should never have
 * offered the action, so reaching here is a bug or a forged request. Secrets
 * in the response are not a concern (the message reveals only that the
 * feature is off).
 */
export function assertCreditsEnabled(e: CreditsEnv): void {
  if (!isCreditsEnabled(e)) throw new Error('Credits are not enabled on this deployment.')
}

// NOTE: this module deliberately does NOT export a helper that reads `@/lib/env`
// itself. `credits-switch` is imported by client components (the shell reads the
// flag from the root loader), and `@/lib/env` pulls in `cloudflare:workers`,
// which cannot be bundled for the browser. Server call sites therefore read env
// locally and pass it to `isCreditsEnabled(env)`.
