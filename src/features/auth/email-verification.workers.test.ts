/**
 * The `AUTH_EMAIL_VERIFY` switch, exercised through the *real* `createAuth`.
 *
 * `test-helpers.ts` builds its own betterAuth instance with verification hard
 * on; these tests need the production wiring — the flag reaching
 * `requireEmailVerification` and `sendOnSignUp` — so they drive `createAuth`.
 *
 * Two test-only accommodations:
 *   - `better-auth/tanstack-start` is stubbed. Its cookie adapter imports
 *     `#tanstack-router-entry`, a virtual specifier only the real Vite build
 *     provides, and it only runs on the path that *sets* a session cookie —
 *     i.e. exactly the "verification off" case under test. (Same reason
 *     `test-helpers.ts` omits the plugin.)
 *   - No mail ever leaves the machine: `sendEmail` reads the real worker env,
 *     where RESEND_API_KEY is unset under the test pool, so it falls back to
 *     the dev transport and logs. The key below only feeds the switch's gate.
 */
import { test, expect, beforeAll, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { createDb } from '@/db/client'
import { applyAuthSchema, extractCookie } from './test-helpers'

vi.mock('better-auth/tanstack-start', () => ({
  tanstackStartCookies: () => ({ id: 'tanstack-start-cookies' }),
}))

const { createAuth } = await import('./auth.server')

const AUTH_ENV = {
  BETTER_AUTH_SECRET: 'test-secret-for-vitest-only-32-chars!!',
  BETTER_AUTH_URL: 'http://localhost',
}

/** Verification emails are stateless-JWT links, so observe the mail itself.
 *  The dev transport logs one `[dev-email] → <to> | <subject>` line per send. */
function captureVerificationMail() {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '))
  })
  return {
    sentTo: (email: string) => lines.filter((l) => l.includes(`→ ${email} `)),
    restore: () => spy.mockRestore(),
  }
}

beforeAll(async () => {
  await applyAuthSchema(env.DB)
})

test('AUTH_EMAIL_VERIFY=false: sign-up issues a session and mails nothing', async () => {
  const db = createDb(env.DB)
  const auth = createAuth({ ...AUTH_ENV, RESEND_API_KEY: 're_test', AUTH_EMAIL_VERIFY: 'false' }, db)
  const email = 'switch-off@example.com'
  const mail = captureVerificationMail()

  const res = await auth.api.signUpEmail({
    body: { email, password: 'Password123!', name: 'Switch Off' },
    asResponse: true,
  })
  mail.restore()
  expect(res.status).toBe(200)

  // The whole point of the switch: the cookie that gets the user into /app.
  const cookie = extractCookie(res)
  const sessionRes = await auth.api.getSession({ headers: new Headers({ cookie }) })
  expect(sessionRes?.user.email).toBe(email)

  // And nothing to go verify — the account is already usable.
  expect(mail.sentTo(email)).toHaveLength(0)
})

test('AUTH_EMAIL_VERIFY unset (default true): sign-up mails a link and issues no session', async () => {
  const db = createDb(env.DB)
  const auth = createAuth({ ...AUTH_ENV, RESEND_API_KEY: 're_test' }, db)
  const email = 'switch-default@example.com'
  const mail = captureVerificationMail()

  const res = await auth.api.signUpEmail({
    body: { email, password: 'Password123!', name: 'Switch Default' },
    asResponse: true,
  })
  mail.restore()
  expect(res.headers.get('set-cookie')).toBeNull()
  expect(mail.sentTo(email)).toHaveLength(1)
})

test('AUTH_EMAIL_VERIFY=true cannot force verification on without Resend', async () => {
  // No RESEND_API_KEY → the link would never be delivered, so the switch stays
  // inert rather than locking every signup out of the dashboard. The link is
  // still minted, though: that is the local dev workflow (paste the console URL).
  const db = createDb(env.DB)
  const auth = createAuth({ ...AUTH_ENV, AUTH_EMAIL_VERIFY: 'true' }, db)
  const email = 'switch-on-nomail@example.com'
  const mail = captureVerificationMail()

  const res = await auth.api.signUpEmail({
    body: { email, password: 'Password123!', name: 'No Mail' },
    asResponse: true,
  })
  mail.restore()
  expect(extractCookie(res)).toContain('better-auth')
  expect(mail.sentTo(email)).toHaveLength(1)
})

test('the default with no Resend still prints a verification link to the console', async () => {
  // Regression guard: `sendOnSignUp` must track operator intent, not enforcement.
  // Tying it to enforcement would silently delete the documented local-dev flow
  // of copying the link out of the console to verify (auth.mdx).
  const db = createDb(env.DB)
  const auth = createAuth({ ...AUTH_ENV }, db)
  const email = 'local-dev@example.com'
  const mail = captureVerificationMail()

  await auth.api.signUpEmail({ body: { email, password: 'Password123!', name: 'Local Dev' } })
  mail.restore()
  expect(mail.sentTo(email)).toHaveLength(1)
})

test('a duplicate sign-up with verification off fails loudly (no account takeover)', async () => {
  // With verification on, better-auth hides duplicates behind a generic success
  // response. Off, the second signup must not quietly sign the person in — this
  // is also the code the register form surfaces as "email already exists".
  const db = createDb(env.DB)
  const auth = createAuth({ ...AUTH_ENV, RESEND_API_KEY: 're_test', AUTH_EMAIL_VERIFY: 'false' }, db)
  const email = 'switch-dup@example.com'

  await auth.api.signUpEmail({ body: { email, password: 'Password123!', name: 'First' } })
  await expect(
    auth.api.signUpEmail({ body: { email, password: 'OtherPass123!', name: 'Impostor' } }),
  ).rejects.toMatchObject({ body: { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' } })
})