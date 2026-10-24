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
import { parseBoolSwitch } from './bool-switch'
// Pure feature module (no cloudflare:workers) — safe to import here so env rules
// and the send path agree on one definition of "which key belongs to which provider".
import {
  EMAIL_API_KEY_VAR,
  EMAIL_PROVIDERS,
  emailApiKeyFor,
  parseFromHeader,
  resolveEmailProviderId,
  type EmailProviderId,
} from '@/features/email/provider'

/** Whether a configured `EMAIL_PROVIDER` string names a provider we can ship to. */
function isEmailProviderId(v: string): v is EmailProviderId {
  const id = v.trim().toLowerCase()
  return (EMAIL_PROVIDERS as readonly string[]).includes(id)
}

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
    // 邮件服务商开关：resend（默认）| flowmails。选 flowmails 时用
    // EMAIL_FLOWMAILS_APIKEY；两者互不回落，见 features/email/provider.ts。
    EMAIL_PROVIDER: optional,
    EMAIL_FLOWMAILS_APIKEY: optional,
    EMAIL_FROM: optional,
    // Sign-up 邮箱验证开关，默认 true；"false" 让注册用户直接进后台。
    // 值是校验过的布尔字面量，解析见 features/auth/email-verification.ts。
    AUTH_EMAIL_VERIFY: optional,
    // 积分系统总开关，默认 false（关）：不显示任何积分页面/导航/文案。
    // 值为校验过的布尔字面量，解析见 features/credits/credits-switch.ts。
    CREDITS_ENABLED: optional,
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

    // A mode switch is a boolean in string clothing, and a typo ("flase") must not
    // read as the default "on" — that would flip a security control silently.
    if (env.AUTH_EMAIL_VERIFY && parseBoolSwitch(env.AUTH_EMAIL_VERIFY) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_EMAIL_VERIFY'],
        message: `AUTH_EMAIL_VERIFY must be true or false (got "${env.AUTH_EMAIL_VERIFY}")`,
      })
    }

    // Same rule for the credits master switch: "flase" silently reading as the
    // default would leave the operator staring at a credits UI they believed
    // they had hidden (or vice versa).
    if (env.CREDITS_ENABLED && parseBoolSwitch(env.CREDITS_ENABLED) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['CREDITS_ENABLED'],
        message: `CREDITS_ENABLED must be true or false (got "${env.CREDITS_ENABLED}")`,
      })
    }

    // Same rule for the provider switch, and higher stakes: `EMAIL_PROVIDER=flowmail`
    // resolving to the default "resend" would keep delivering verification mail
    // through a different provider than the operator asked for — or, with no Resend
    // key, silently downgrade to the console. Hard-fail instead.
    if (env.EMAIL_PROVIDER && !isEmailProviderId(env.EMAIL_PROVIDER)) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_PROVIDER'],
        message: `EMAIL_PROVIDER must be one of ${EMAIL_PROVIDERS.join(', ')} (got "${env.EMAIL_PROVIDER}")`,
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

  // Asked for email verification but no way to deliver the mail: the switch is
  // then inert and sign-ups go straight through (features/auth/email-verification.ts).
  // That is a security decision nobody made on purpose — say so at boot. The key
  // that matters is the one for the *selected* provider, hence the lookup.
  const emailProvider = resolveEmailProviderId(raw)
  const emailKeyVar = EMAIL_API_KEY_VAR[emailProvider]
  if (parseBoolSwitch(raw.AUTH_EMAIL_VERIFY) === true && !emailApiKeyFor(emailProvider, raw)) {
    warnings.push(
      `AUTH_EMAIL_VERIFY is on but ${emailKeyVar} is not set — email verification will stay OFF ` +
        'and verification emails cannot be delivered. Set ' +
        `${emailKeyVar} (+ EMAIL_FROM) or set AUTH_EMAIL_VERIFY=false if you meant to skip verification.`,
    )
  }

  // An explicitly chosen provider that cannot send is the same silent hole as
  // above, minus the AUTH_EMAIL_VERIFY hint. Only *explicit* choices are audited:
  // an unset EMAIL_PROVIDER means "resend, if it happens to be configured".
  if (has('EMAIL_PROVIDER') && isEmailProviderId(raw.EMAIL_PROVIDER!)) {
    if (!emailApiKeyFor(emailProvider, raw)) {
      warnings.push(
        `EMAIL_PROVIDER is "${emailProvider}" but ${emailKeyVar} is not set — every email degrades to ` +
          'the console capture transport and is never delivered. ' +
          `Set ${emailKeyVar}, or set EMAIL_PROVIDER=resend to go back to Resend.`,
      )
    }
    // Flowmails has no shared test sender: `from` must be a bare address on the
    // domain the key is bound to (the backend answers 422 `from_domain_mismatch`
    // otherwise), so an unset/garbled EMAIL_FROM leaves us nothing to send with.
    if (emailProvider === 'flowmails' && !parseFromHeader(raw.EMAIL_FROM)) {
      warnings.push(
        'EMAIL_PROVIDER is "flowmails" but EMAIL_FROM is unset or not an address — Flowmails requires ' +
          'a from address on the domain your API key is bound to (e.g. "Support <hi@yourdomain.com>"), ' +
          'so emails degrade to the console capture transport.',
      )
    }
  }

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
  // Deployed build (staging/prod) without a mail provider key: email verification is
  // turned off (auth.server.ts `requireEmailVerification`) and password-reset links
  // can't be delivered — an account-ownership gap. We degrade per the "missing
  // key → feature off" convention, but never silently on a real deployment.
  // `import.meta.env.PROD` is true for any built worker, false under `pnpm dev`.
  const deployProvider = resolveEmailProviderId(raw)
  if (import.meta.env.PROD && !emailApiKeyFor(deployProvider, raw)) {
    console.warn(
      `[env] ⚠️ ${EMAIL_API_KEY_VAR[deployProvider]} is not set in a deployed build (EMAIL_PROVIDER=${deployProvider}) ` +
        '— email verification is OFF and password-reset emails cannot be delivered. ' +
        `Set ${EMAIL_API_KEY_VAR[deployProvider]} (+ EMAIL_FROM) for any real production deployment.`,
    )
  }
  if (errors.length) {
    throw new Error(`Invalid environment configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
  }
  // Memoize only after success — a misconfigured isolate must fail on EVERY request, not just the first.
  checked = true
}
