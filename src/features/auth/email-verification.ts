/**
 * The `AUTH_EMAIL_VERIFY` switch: whether sign-up demands a verified email.
 *
 * Two independent things stand between a new account and the dashboard:
 *
 *   1. the operator's intent — `AUTH_EMAIL_VERIFY` (default ON; set it to
 *      `false` and sign-up hands back a session, so the user lands in /app
 *      with no round trip through their inbox);
 *   2. the ability to deliver the link — an API key for the *selected*
 *      provider (`EMAIL_PROVIDER`, default Resend). Without it the mail
 *      only reaches the dev log, so enforcing verification would lock every
 *      signup out permanently. That stays off, per the repo-wide
 *      "missing key → feature off" rule (see AGENTS.md).
 *
 * So the switch can turn verification OFF but never ON: only
 * `AUTH_EMAIL_VERIFY !== false && hasEmailDelivery(env)` *enforces* it. An
 * unrecognized value (`flase`, `maybe`) is rejected at boot by env-validate;
 * if one ever reached this function anyway it counts as wanted — the safe
 * direction, since the cost of guessing wrong is a locked-out user rather
 * than an unverified one.
 *
 * The deliverability question is *not* re-implemented here: `hasEmailDelivery`
 * (features/email/provider.ts) is the single place that knows which key belongs
 * to which provider, so switching `EMAIL_PROVIDER=flowmails` moves this gate
 * to `EMAIL_FLOWMAILS_APIKEY` without touching this file.
 *
 * Intent and enforcement stay separate functions on purpose. "Wanted" drives
 * `sendOnSignUp`, so a local dev without a mail key still mints the link and
 * prints it to the console (the documented way to verify locally); only the
 * operator switching it off stops that mail.
 *
 * Takes env as a parameter instead of importing `@/lib/env`, so this module
 * stays pure and node-testable (same shape as `isWechatPayEnabled`).
 */
import { parseBoolSwitch } from '@/lib/bool-switch'
import { hasEmailDelivery, type EmailEnv } from '@/features/email/provider'

export interface EmailVerificationEnv extends EmailEnv {
  /** Operator switch. Unset/blank = ON. `false`/`0`/`off`/`no` = OFF. */
  AUTH_EMAIL_VERIFY?: string
  /** Without a key for the selected provider the mail is never actually delivered. */
  RESEND_API_KEY?: string
  EMAIL_FLOWMAILS_APIKEY?: string
}

/** Operator intent, independent of whether a link can actually be delivered. */
export function isEmailVerificationWanted(e: EmailVerificationEnv): boolean {
  return parseBoolSwitch(e.AUTH_EMAIL_VERIFY) !== false
}

/** What sign-up actually enforces: wanted *and* deliverable. */
export function isEmailVerificationEnabled(e: EmailVerificationEnv): boolean {
  return isEmailVerificationWanted(e) && hasEmailDelivery(e)
}