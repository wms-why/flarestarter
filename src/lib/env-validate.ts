/**
 * Fail-fast environment validation via a zod schema.
 *
 * The schema is the single source of truth for what a valid env looks like;
 * `Env` is inferred from it, so the shape and the types never drift. Conditional
 * rules (OAuth pairs, Stripe webhook secret) live in `superRefine`. Soft advice
 * that shouldn't block startup (e.g. Stripe key but no price ids) is returned as
 * `warnings`, since zod issues are all hard errors.
 *
 * `validateEnv` is pure (unit-tested in the node pool); `assertEnvOnce` runs it
 * once per isolate from the server entry — `env` is imported lazily there so the
 * pure path stays importable where `cloudflare:workers` can't resolve.
 */
import { z } from 'zod'

/** Wrangler declares unset vars as "" — treat empty/whitespace as absent. */
const optional = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
)

const envSchema = z
  .object({
    // Core — the app cannot function without these.
    BETTER_AUTH_SECRET: z
      .string({ error: 'BETTER_AUTH_SECRET is required' })
      .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
    BETTER_AUTH_URL: z.url({ error: 'BETTER_AUTH_URL must be a valid absolute URL' }),

    RESEND_API_KEY: optional,
    RESEND_AUDIENCE_ID: optional,
    EMAIL_FROM: optional,
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    GITHUB_CLIENT_ID: optional,
    GITHUB_CLIENT_SECRET: optional,
    STRIPE_SECRET_KEY: optional,
    STRIPE_WEBHOOK_SECRET: optional,
    // Billing — provider roster + per-vendor secrets. Blank keys switch a vendor
    // off; see features/billing/providers/catalog.ts for the gate.
    BILLING_PROVIDERS: optional,
    WAFFO_ENV: optional,
    CREEM_ENV: optional,
    PAYPAL_ENV: optional,
    WAFFO_MERCHANT_ID: optional,
    WAFFO_PRIVATE_KEY: optional,
    WAFFO_PRIVATE_KEY_BASE64: optional,
    WAFFO_WEBHOOK_PUBLIC_KEY: optional,
    CREEM_API_KEY: optional,
    CREEM_WEBHOOK_SECRET: optional,
    PAYPAL_CLIENT_ID: optional,
    PAYPAL_CLIENT_SECRET: optional,
    PAYPAL_WEBHOOK_ID: optional,
    // Kill switch for WeChat Pay on sponsorships — see features/sponsor/sponsor.config.ts.
    STRIPE_WECHAT_PAY_ENABLED: optional,
    ADMIN_EMAILS: optional,
    TURNSTILE_SITE_KEY: optional,
    TURNSTILE_SECRET_KEY: optional,
    CF_ANALYTICS_TOKEN: optional,
    SENTRY_DSN: optional,
  })
  .superRefine((env, ctx) => {
    // OAuth: half a pair is always a misconfiguration.
    const pair = (a: keyof typeof env, b: keyof typeof env, label: string) => {
      if (!!env[a] !== !!env[b]) {
        ctx.addIssue({ code: 'custom', path: [a], message: `${label}: set both ${a} and ${b}, or neither` })
      }
    }
    pair('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'Google OAuth')
    pair('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GitHub OAuth')
    pair('TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'Turnstile')

    // Billing providers: only judged when the operator actually listed them.
    //
    // Gating on BILLING_PROVIDERS is what keeps this from breaking a deploy.
    // An unset switch means "all four, each still secret-gated", so judging
    // every vendor unconditionally would hard-crash boot for someone who set
    // CREEM_API_KEY months ago and never turned Creem on — the opposite of the
    // repo's graceful-degradation rule.
    const enabled = (env.BILLING_PROVIDERS ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    if (enabled.includes('waffo')) {
      // Waffo accepts the private key in two shapes; having both is fine, but
      // its merchant id / webhook key / private key are all-or-nothing.
      pair('WAFFO_MERCHANT_ID', 'WAFFO_WEBHOOK_PUBLIC_KEY', 'Waffo Pancake')
    }
    if (enabled.includes('creem')) pair('CREEM_API_KEY', 'CREEM_WEBHOOK_SECRET', 'Creem')
    if (enabled.includes('paypal')) pair('PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PayPal')

    // A Stripe secret key with no webhook secret means webhooks fail signature
    // verification silently.
    if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_WEBHOOK_SECRET'],
        message: 'STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set',
      })
    }
  })

/** Fully-validated env. Required fields are non-optional here. */
export type Env = z.infer<typeof envSchema>

export interface EnvReport {
  errors: string[]
  warnings: string[]
}

/**
 * Validate raw env. Returns hard `errors` (block startup) and soft `warnings`.
 *
 * `extra.configuredProviders` is the list of vendors that have at least one
 * product id in plans.ts. It is injected rather than imported so this stays a
 * pure function (node-tested, no cloudflare:workers in its module graph); see
 * `assertEnvOnce` for the caller that supplies it.
 */
export function validateEnv(
  raw: Record<string, string | undefined>,
  extra: { configuredProviders?: readonly string[] } = {},
): EnvReport {
  const result = envSchema.safeParse(raw)
  const errors = result.success
    ? []
    : result.error.issues.map((i) => i.message)

  // Soft advice — never blocks startup.
  const warnings: string[] = []
  const has = (k: string) => typeof raw[k] === 'string' && raw[k]!.trim() !== ''

  // (No "no product ids" warning: product ids moved into plans.ts, a TS module
  // this pure validator deliberately does not import. The registry reports an
  // unconfigured tier on the checkout page instead, where the operator sees it.)

  // A provider the operator explicitly listed, whose secrets are missing, hides
  // itself from the checkout page silently — worth hearing at boot rather than
  // from the first customer who tries to pay.
  //
  // Only *explicitly* listed ids are audited. An unset BILLING_PROVIDERS means
  // "all vendors, each still secret-gated", so warning about every vendor that
  // happens to be unconfigured would fire on every fresh install and train
  // operators to ignore the output.
  const explicitlyEnabled = (raw.BILLING_PROVIDERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  // Plans.ts is a TS module this pure validator deliberately does not import,
  // so the caller passes the configured vendor ids in. See `assertEnvOnce`.
  const configured = extra.configuredProviders ?? []
  for (const id of explicitlyEnabled) {
    const missing = REQUIRED_SECRETS[id]?.filter((k) => !has(k)) ?? []
    if (id === 'waffo' && !has('WAFFO_PRIVATE_KEY') && !has('WAFFO_PRIVATE_KEY_BASE64')) {
      missing.push('WAFFO_PRIVATE_KEY (or WAFFO_PRIVATE_KEY_BASE64)')
    }
    if (missing.length > 0) {
      warnings.push(`BILLING_PROVIDERS lists "${id}" but these are not set: ${missing.join(', ')} — it will not appear at checkout`)
      continue
    }
    // Secrets are in place but no product ids are. Nothing fails: webhooks
    // verify, the pricing page renders — and then a paying customer is charged
    // and silently granted nothing, because their price id cannot be resolved
    // back to a tier. This is the one misconfiguration worth shouting about.
    if (configured && !configured.includes(id)) {
      warnings.push(`Billing provider "${id}" is fully configured but plans.ts has no product ids for it — checkout will be unavailable and any sale would grant no entitlement. Fill productIds in src/features/billing/plans.ts.`)
    }
  }

  return { errors, warnings }
}

/** Secret set each vendor needs before it can be used at all. */
const REQUIRED_SECRETS: Record<string, string[]> = {
  stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  // Waffo's private key has two accepted encodings, so either satisfies it.
  waffo: ['WAFFO_MERCHANT_ID', 'WAFFO_WEBHOOK_PUBLIC_KEY'],
  creem: ['CREEM_API_KEY', 'CREEM_WEBHOOK_SECRET'],
  paypal: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'],
}

let checked = false

/** Validate the live env once per isolate. Warns on soft issues, throws on hard ones. */
export async function assertEnvOnce(): Promise<void> {
  if (checked) return
  const { env } = await import('./env')
  const raw = env as unknown as Record<string, string | undefined>
  // Imported lazily so the pure validation path stays importable where
  // `cloudflare:workers` cannot resolve (node tests).
  const { configuredProviders } = await import('@/features/billing/plans')
  const { errors, warnings } = validateEnv(raw, { configuredProviders: configuredProviders() })
  for (const w of warnings) console.warn(`[env] ${w}`)
  // Deployed build (staging/prod) without Resend: email verification is turned
  // off (auth.server.ts `requireEmailVerification`) and password-reset links
  // can't be delivered — an account-ownership gap. We degrade per the "missing
  // key → feature off" convention, but never silently on a real deployment.
  // `import.meta.env.PROD` is true for any built worker, false under `pnpm dev`.
  if (import.meta.env.PROD && !raw.RESEND_API_KEY?.trim()) {
    console.warn(
      '[env] ⚠️ RESEND_API_KEY is not set in a deployed build — email verification is OFF ' +
        'and password-reset emails cannot be delivered. Set RESEND_API_KEY (+ EMAIL_FROM) ' +
        'for any real production deployment.',
    )
  }
  if (errors.length) {
    throw new Error(`Invalid environment configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
  }
  // Memoize only after success — a misconfigured isolate must fail on EVERY request, not just the first.
  checked = true
}
