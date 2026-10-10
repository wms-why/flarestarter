import { test, expect, vi } from 'vitest'
import { validateEnv } from './env-validate'

const SECRET = 'x'.repeat(32)
const ok = { BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: 'https://app.example.com' }

test('a minimal valid env has no errors or warnings', () => {
  expect(validateEnv(ok)).toEqual({ errors: [], warnings: [] })
})

test('missing core vars are errors', () => {
  const r = validateEnv({})
  expect(r.errors).toEqual(
    expect.arrayContaining([
      expect.stringContaining('BETTER_AUTH_SECRET'),
      expect.stringContaining('BETTER_AUTH_URL'),
    ]),
  )
})

test('short secret and bad url are errors', () => {
  const r = validateEnv({ BETTER_AUTH_SECRET: 'tooshort', BETTER_AUTH_URL: 'not a url' })
  expect(r.errors).toEqual(
    expect.arrayContaining([
      expect.stringContaining('at least 32'),
      expect.stringContaining('valid absolute URL'),
    ]),
  )
})

test('half an OAuth pair is an error; a full pair is fine', () => {
  expect(validateEnv({ ...ok, GOOGLE_CLIENT_ID: 'id' }).errors).toEqual([
    expect.stringContaining('Google OAuth'),
  ])
  expect(validateEnv({ ...ok, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' }).errors).toEqual([])
})

test('half a Turnstile pair is an error; a full pair is fine', () => {
  expect(validateEnv({ ...ok, TURNSTILE_SITE_KEY: 'k' }).errors).toEqual([
    expect.stringContaining('Turnstile'),
  ])
  expect(validateEnv({ ...ok, TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's' }).errors).toEqual([])
})

test('Stripe key without webhook secret is an error', () => {
  const r = validateEnv({ ...ok, STRIPE_SECRET_KEY: 'sk_test' })
  expect(r.errors).toEqual([expect.stringContaining('STRIPE_WEBHOOK_SECRET')])
  // Product ids now live in plans.ts, so there is no env-side price-id warning.
  expect(r.warnings).toEqual([])
})

// ── AUTH_EMAIL_VERIFY ──────────────────────────────────────────────────────
test('a boolean-ish AUTH_EMAIL_VERIFY is accepted', () => {
  for (const v of ['true', 'false', 'TRUE', '0', 'on', 'off', 'yes', 'no']) {
    expect(validateEnv({ ...ok, AUTH_EMAIL_VERIFY: v }).errors).toEqual([])
  }
})

test('an unset or blank AUTH_EMAIL_VERIFY stays silent', () => {
  expect(validateEnv({ ...ok, RESEND_API_KEY: 're_x' })).toEqual({ errors: [], warnings: [] })
  expect(validateEnv({ ...ok, RESEND_API_KEY: 're_x', AUTH_EMAIL_VERIFY: '' })).toEqual({
    errors: [],
    warnings: [],
  })
})

test('a typo in AUTH_EMAIL_VERIFY fails startup instead of silently meaning "on"', () => {
  const r = validateEnv({ ...ok, RESEND_API_KEY: 're_x', AUTH_EMAIL_VERIFY: 'flase' })
  expect(r.errors).toEqual([expect.stringContaining('AUTH_EMAIL_VERIFY must be true or false')])
})

test('AUTH_EMAIL_VERIFY=true with no Resend warns — the switch cannot force it on', () => {
  const r = validateEnv({ ...ok, AUTH_EMAIL_VERIFY: 'true' })
  expect(r.errors).toEqual([])
  expect(r.warnings.some((w) => w.includes('AUTH_EMAIL_VERIFY') && w.includes('RESEND_API_KEY'))).toBe(true)
})

test('AUTH_EMAIL_VERIFY=false without Resend is exactly what was asked for — no warning', () => {
  const r = validateEnv({ ...ok, AUTH_EMAIL_VERIFY: 'false' })
  expect(r).toEqual({ errors: [], warnings: [] })
})

// ── EMAIL_PROVIDER ──────────────────────────────────────────────────────────
// A typo here is worse than a typo in a boolean: it would keep delivering mail
// through a service the operator did not pick, so it fails startup outright.
const FLOWMAILS_OK = { EMAIL_PROVIDER: 'flowmails', EMAIL_FLOWMAILS_APIKEY: 'fm_x', EMAIL_FROM: 'Support <hi@acme.dev>' }

test('both provider ids are accepted, in any casing', () => {
  expect(validateEnv({ ...ok, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' }).errors).toEqual([])
  expect(validateEnv({ ...ok, ...FLOWMAILS_OK }).errors).toEqual([])
  expect(validateEnv({ ...ok, ...FLOWMAILS_OK, EMAIL_PROVIDER: ' FlowMails ' }).errors).toEqual([])
})

test('a typo in EMAIL_PROVIDER is a hard error, not a silent fallback to resend', () => {
  const r = validateEnv({ ...ok, EMAIL_PROVIDER: 'flowmail' })
  expect(r.errors.join()).toContain('EMAIL_PROVIDER must be one of resend, flowmails')
})

test('a fully configured flowmails install is clean', () => {
  expect(validateEnv({ ...ok, ...FLOWMAILS_OK })).toEqual({ errors: [], warnings: [] })
})

test('an explicitly chosen provider with no key warns — every mail degrades to the console', () => {
  const r = validateEnv({ ...ok, EMAIL_PROVIDER: 'flowmails', EMAIL_FROM: 'hi@acme.dev' })
  expect(r.errors).toEqual([])
  expect(r.warnings.some((w) => w.includes('EMAIL_PROVIDER') && w.includes('EMAIL_FLOWMAILS_APIKEY'))).toBe(true)
})

test('flowmails without EMAIL_FROM warns — its key is bound to one domain, so there is no shared test sender', () => {
  const r = validateEnv({ ...ok, EMAIL_PROVIDER: 'flowmails', EMAIL_FLOWMAILS_APIKEY: 'fm_x' })
  expect(r.errors).toEqual([])
  expect(r.warnings.some((w) => w.includes('EMAIL_FROM'))).toBe(true)
  // A garbage sender is the same failure, not a sendable address.
  expect(validateEnv({ ...ok, EMAIL_PROVIDER: 'flowmails', EMAIL_FLOWMAILS_APIKEY: 'fm_x', EMAIL_FROM: 'Acme' }).warnings
    .some((w) => w.includes('EMAIL_FROM'))).toBe(true)
})

test('the AUTH_EMAIL_VERIFY warning names the key of the selected provider', () => {
  const r = validateEnv({ ...ok, AUTH_EMAIL_VERIFY: 'true', EMAIL_PROVIDER: 'flowmails', EMAIL_FROM: 'hi@acme.dev' })
  expect(r.warnings.some((w) => w.includes('AUTH_EMAIL_VERIFY') && w.includes('EMAIL_FLOWMAILS_APIKEY'))).toBe(true)
  // A Resend key does not satisfy a flowmails deployment.
  const onlyResend = validateEnv({ ...ok, AUTH_EMAIL_VERIFY: 'true', EMAIL_PROVIDER: 'flowmails', EMAIL_FROM: 'hi@acme.dev', RESEND_API_KEY: 're_x' })
  expect(onlyResend.warnings.some((w) => w.includes('EMAIL_FLOWMAILS_APIKEY'))).toBe(true)
})

test('an unset EMAIL_PROVIDER stays silent about flowmails even with its key present', () => {
  // Not selecting flowmails is a legitimate Resend deployment.
  expect(validateEnv({ ...ok, RESEND_API_KEY: 're_x', EMAIL_FLOWMAILS_APIKEY: 'fm_x' }))
    .toEqual({ errors: [], warnings: [] })
})

test('assertEnvOnce keeps throwing on EVERY call while the env is invalid', async () => {
  // Regression: the memo flag must not be set before validation, or only the
  // first request per isolate fails and the rest serve with a broken env.
  vi.resetModules()
  vi.doMock('./env', () => ({ env: {} })) // missing all core vars → hard errors
  const { assertEnvOnce } = await import('./env-validate')
  await expect(assertEnvOnce()).rejects.toThrow('Invalid environment configuration')
  await expect(assertEnvOnce()).rejects.toThrow('Invalid environment configuration')
  vi.doUnmock('./env')
})

test('assertEnvOnce passes and memoizes on a valid env', async () => {
  vi.resetModules()
  vi.doMock('./env', () => ({ env: { BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: 'https://app.example.com' } }))
  const { assertEnvOnce } = await import('./env-validate')
  await expect(assertEnvOnce()).resolves.toBeUndefined()
  await expect(assertEnvOnce()).resolves.toBeUndefined()
  vi.doUnmock('./env')
})

test('Stripe fully configured is clean', () => {
  const r = validateEnv({
    ...ok,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec',
    STRIPE_PRICE_PRO_MONTHLY: 'price_123',
  })
  expect(r).toEqual({ errors: [], warnings: [] })
})

// ── Billing providers ──────────────────────────────────────────────────────
const STRIPE_OK = { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' }
const CREEM = { CREEM_API_KEY: 'k', CREEM_WEBHOOK_SECRET: 's' }
const PAYPAL = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_WEBHOOK_ID: 'WH-1' }
const WAFFO = { WAFFO_MERCHANT_ID: 'MER_1', WAFFO_PRIVATE_KEY: 'pem', WAFFO_WEBHOOK_PUBLIC_KEY: 'pub' }

test('a fully configured provider produces no errors and no warnings', () => {
  const all = { ...CREEM, ...PAYPAL, ...WAFFO, ...STRIPE_OK }
  const r = validateEnv({ ...ok, ...all, BILLING_PROVIDERS: 'creem,paypal,waffo,stripe' }, { configuredProviders: ['creem', 'paypal', 'waffo', 'stripe'] })
  expect(r.errors).toEqual([])
  expect(r.warnings).toEqual([])
})

test('a half-configured pair is a hard error once the vendor is listed', () => {
  expect(validateEnv({ ...ok, CREEM_API_KEY: 'k', BILLING_PROVIDERS: 'creem' }).errors.join())
    .toContain('Creem: set both CREEM_API_KEY and CREEM_WEBHOOK_SECRET')
  expect(validateEnv({ ...ok, PAYPAL_CLIENT_ID: 'id', BILLING_PROVIDERS: 'paypal' }).errors.join())
    .toContain('PayPal: set both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET')
  expect(validateEnv({ ...ok, WAFFO_MERCHANT_ID: 'MER_1', BILLING_PROVIDERS: 'waffo' }).errors.join())
    .toContain('Waffo Pancake: set both WAFFO_MERCHANT_ID and WAFFO_WEBHOOK_PUBLIC_KEY')
})

test('PayPal without a webhook id is incomplete, not an error — it just cannot be used', () => {
  // It would mint checkouts but never record completions, so it must not appear
  // at checkout; that is a warning, not a boot failure.
  const r = validateEnv({ ...ok, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'sec', BILLING_PROVIDERS: 'paypal' })
  expect(r.errors).toEqual([])
  expect(r.warnings.some((w) => w.includes('PAYPAL_WEBHOOK_ID'))).toBe(true)
})

test('the base64 private key satisfies Waffo on its own', () => {
  const r = validateEnv({ ...ok, WAFFO_MERCHANT_ID: 'MER_1', WAFFO_WEBHOOK_PUBLIC_KEY: 'pub', WAFFO_PRIVATE_KEY_BASE64: 'cGVt' })
  expect(r.errors).toEqual([])
})

test('a half-set credential pair is a hard error, matching the OAuth rules', () => {
  // Consistent with GOOGLE_*/GITHUB_*: half a pair is always a misconfiguration,
  // so it fails fast rather than silently disappearing from checkout.
  const r = validateEnv({ ...ok, BILLING_PROVIDERS: 'creem', CREEM_API_KEY: 'k' })
  expect(r.errors).toEqual([expect.stringContaining('Creem: set both CREEM_API_KEY and CREEM_WEBHOOK_SECRET')])
})

test('an enabled provider with no secrets at all warns instead of failing startup', () => {
  const r = validateEnv({ ...ok, BILLING_PROVIDERS: 'paypal' })
  expect(r.errors).toEqual([])
  expect(r.warnings.some((w) => w.includes('"paypal"') && w.includes('PAYPAL_CLIENT_ID') && w.includes('PAYPAL_WEBHOOK_ID'))).toBe(true)
})

test('waffo named in BILLING_PROVIDERS reports its key pair under either encoding', () => {
  const r = validateEnv({ ...ok, BILLING_PROVIDERS: 'waffo' })
  expect(r.warnings.some((w) => w.includes('"waffo"') && w.includes('WAFFO_MERCHANT_ID'))).toBe(true)
  expect(r.warnings.some((w) => w.includes('WAFFO_PRIVATE_KEY_BASE64'))).toBe(true)
})

test('an unset BILLING_PROVIDERS does not warn about unconfigured vendors', () => {
  // Unset means "all of them, each still secret-gated" — auditing that default
  // would fire on every fresh install and make the warnings meaningless.
  const r = validateEnv({ ...ok, ...STRIPE_OK })
  expect(r.errors).toEqual([])
  expect(r.warnings).toEqual([])
})

test('a fully provisioned default env stays silent', () => {
  const r = validateEnv({ ...ok, ...STRIPE_OK, ...CREEM, ...PAYPAL, ...WAFFO }, { configuredProviders: ['stripe', 'creem', 'paypal', 'waffo'] })
  expect(r.errors).toEqual([])
  expect(r.warnings).toEqual([])
})

// ── plan-registry gating ───────────────────────────────────────────────────
// Judging every billing vendor unconditionally would hard-crash boot for an
// operator who set CREEM_API_KEY long ago and never enabled Creem — the exact
// opposite of the repo's graceful-degradation rule.
test('a half-set credential pair does NOT fail startup unless the provider is listed', () => {
  const off = validateEnv({ ...ok, CREEM_API_KEY: 'k', PAYPAL_CLIENT_ID: 'id' })
  expect(off.errors).toEqual([])

  const on = validateEnv({ ...ok, CREEM_API_KEY: 'k', BILLING_PROVIDERS: 'creem' })
  expect(on.errors.join()).toContain('Creem: set both')
})

test('BILLING_PROVIDERS=waffo does not drag in creem/paypal pair errors', () => {
  const r = validateEnv({ ...ok, CREEM_API_KEY: 'k', PAYPAL_CLIENT_ID: 'id', BILLING_PROVIDERS: 'waffo' })
  expect(r.errors).toEqual([])
})

test('a configured provider with no product ids warns — this is how a charged-but-ungranted sale gets caught', () => {
  const r = validateEnv(
    { ...ok, ...STRIPE_OK, BILLING_PROVIDERS: 'stripe' },
    { configuredProviders: ['creem', 'paypal'] },
  )
  expect(r.errors).toEqual([])
  expect(r.warnings.some((w) => w.includes('"stripe"') && w.includes('no product ids'))).toBe(true)
})

test('a configured provider WITH product ids stays silent', () => {
  const r = validateEnv(
    { ...ok, ...STRIPE_OK, BILLING_PROVIDERS: 'stripe' },
    { configuredProviders: ['stripe'] },
  )
  expect(r.warnings).toEqual([])
})

test('a listed provider that is merely unconfigured does not also get the product-ids warning', () => {
  // Missing secrets is the warning; "no product ids" only applies once the
  // secrets are there and the mistake is somewhere else entirely.
  const r = validateEnv({ ...ok, BILLING_PROVIDERS: 'stripe' }, { configuredProviders: ['stripe'] })
  expect(r.warnings).toHaveLength(1)
  expect(r.warnings[0]).toContain('STRIPE_SECRET_KEY')
  expect(r.warnings[0]).not.toContain('product ids')
})
