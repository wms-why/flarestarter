import { test, expect } from 'vitest'
import { isEmailVerificationEnabled, isEmailVerificationWanted } from './email-verification'

// The switch can only turn verification OFF. Turning it ON additionally requires
// a way to deliver the mail — otherwise every signup is locked out forever.
//
// Intent (`isEmailVerificationWanted`) and enforcement (`isEmailVerificationEnabled`)
// are separate: intent drives whether the link is sent at all, so local dev
// without Resend still prints one to the console.

test('unset switch + Resend configured = verification on (the default)', () => {
  expect(isEmailVerificationEnabled({ RESEND_API_KEY: 're_x' })).toBe(true)
})

test('unset switch + no Resend = off, because the link could never be delivered', () => {
  expect(isEmailVerificationEnabled({})).toBe(false)
})

test('blank AUTH_EMAIL_VERIFY reads as unset, not as "off"', () => {
  // Wrangler declares undeclared vars as "" — that must not silently disable a
  // security control.
  expect(isEmailVerificationEnabled({ AUTH_EMAIL_VERIFY: '', RESEND_API_KEY: 're_x' })).toBe(true)
  expect(isEmailVerificationEnabled({ AUTH_EMAIL_VERIFY: '   ', RESEND_API_KEY: 're_x' })).toBe(true)
})

test('explicit false turns verification off even with Resend configured', () => {
  expect(isEmailVerificationEnabled({ AUTH_EMAIL_VERIFY: 'false', RESEND_API_KEY: 're_x' })).toBe(false)
})

test('off spellings are case/whitespace insensitive; on spellings stay on', () => {
  for (const v of ['FALSE', ' False ', '0', 'off', 'no']) {
    expect(isEmailVerificationEnabled({ AUTH_EMAIL_VERIFY: v, RESEND_API_KEY: 're_x' })).toBe(false)
  }
  for (const v of ['true', 'TRUE', '1', 'on', 'yes']) {
    expect(isEmailVerificationEnabled({ AUTH_EMAIL_VERIFY: v, RESEND_API_KEY: 're_x' })).toBe(true)
  }
})

test('the switch cannot force verification ON without Resend', () => {
  // Asking for verification we cannot deliver would strand every signup.
  expect(isEmailVerificationEnabled({ AUTH_EMAIL_VERIFY: 'true' })).toBe(false)
  expect(isEmailVerificationEnabled({ AUTH_EMAIL_VERIFY: 'true', RESEND_API_KEY: '' })).toBe(false)
  expect(isEmailVerificationEnabled({ AUTH_EMAIL_VERIFY: 'true', RESEND_API_KEY: '  ' })).toBe(false)
})

test('an unparseable value fails closed (on), and boot rejects it separately', () => {
  // env-validate turns "flase" into a hard startup error; if one ever slipped
  // through, "on" is the safe reading — the cost is a locked-out user, not an
  // unverified one.
  expect(isEmailVerificationEnabled({ AUTH_EMAIL_VERIFY: 'flase', RESEND_API_KEY: 're_x' })).toBe(true)
})

test('intent ignores Resend; only an explicit off withdraws it', () => {
  // This is what keeps the local-dev console workflow alive: with no Resend the
  // link is still minted (and printed), it just isn't enforced.
  expect(isEmailVerificationWanted({})).toBe(true)
  expect(isEmailVerificationWanted({ AUTH_EMAIL_VERIFY: 'true' })).toBe(true)
  expect(isEmailVerificationWanted({ AUTH_EMAIL_VERIFY: 'flase' })).toBe(true)
  expect(isEmailVerificationWanted({ AUTH_EMAIL_VERIFY: 'false' })).toBe(false)
  expect(isEmailVerificationWanted({ AUTH_EMAIL_VERIFY: 'off' })).toBe(false)
})

// ── EMAIL_PROVIDER ──────────────────────────────────────────────────────────
// Enforcement follows the *selected* provider's key. A half-done switch (flowmails
// chosen, only a Resend key present) must behave like "no key at all" — turning
// verification off — rather than quietly delivering through the other service.
test('flowmails selected + its key = verification on', () => {
  expect(isEmailVerificationEnabled({ EMAIL_PROVIDER: 'flowmails', EMAIL_FLOWMAILS_APIKEY: 'fm_x' })).toBe(true)
})

test('a half-finished switch cannot deliver, so verification stays off', () => {
  expect(isEmailVerificationEnabled({ EMAIL_PROVIDER: 'flowmails', RESEND_API_KEY: 're_x' })).toBe(false)
  expect(isEmailVerificationEnabled({ EMAIL_PROVIDER: 'flowmails', EMAIL_FLOWMAILS_APIKEY: '  ' })).toBe(false)
})

test('switching back to resend keeps working with the resend key alone', () => {
  expect(isEmailVerificationEnabled({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' })).toBe(true)
})