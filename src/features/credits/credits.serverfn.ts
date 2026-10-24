/**
 * Credits server fns — the only bridge between the credits UI and the
 * `credits.server` core.
 *
 * Each handler is a separate module from the route file for the same reason as
 * `billing.serverfn.ts`: a route file compiles into both the client and server
 * bundles, and importing the core/registry would drag server-only code (env,
 * vendor SDKs, `cloudflare:workers`) into the browser. `createServerFn(...)`
 * keeps the handler body server-only.
 *
 * Env + `createDb` are imported lazily inside each handler so the module stays
 * importable from tests and the client's type-only surface.
 */
import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'
import { clampPage, clampPageSize } from '@/features/admin/params'
import { user } from '@/features/auth/auth.schema'
import type { BillingEnv } from '@/features/billing/providers/registry'
import type { ProviderId } from '@/features/billing/providers/catalog'
// Type-only imports are erased at compile time; they never reach the client bundle.
import type { CreditAccountView } from './credits.server'
import type { CreditLedgerRow } from './credits.schema'
import type { CreditPack } from './credit-packs'

export interface CreditsOverview {
  account: CreditAccountView
  ledger: { rows: CreditLedgerRow[]; total: number }
  packs: CreditPack[]
  providers: ProviderId[]
  packProviderErrors: { packId: string; errors: string[] }[]
}

/**
 * Everything the credits page needs in one round trip: the account (balance +
 * period), the first ledger page, the pack catalogue, and which providers can
 * actually sell which pack.
 */
/**
 * Whether the credits feature is switched on, asked over the server-fn boundary.
 *
 * Route loaders need this, but they cannot import `@/lib/env` themselves: route
 * modules are bundled for the client too, and env pulls in `cloudflare:workers`.
 * Going through a server fn keeps the decision on the server and the client
 * bundle free of bindings.
 */
export const creditsFeatureEnabled = createServerFn({ method: 'GET' }).handler(
  async (): Promise<boolean> => {
    const { env } = await import('@/lib/env')
    const { isCreditsEnabled } = await import('./credits-switch')
    return isCreditsEnabled(env)
  },
)

export const getCredits = createServerFn({ method: 'GET' })
  .validator((d: { page?: number; pageSize?: number }) => ({ page: clampPage(d?.page), pageSize: clampPageSize(d?.pageSize) }))
  .handler(async ({ data }): Promise<CreditsOverview> => {
    const { env } = await import('@/lib/env')
    const { createDb } = await import('@/db/client')
    const { readUser } = await import('@/features/auth/readUser.server')
    const { getCreditAccount, listLedger } = await import('./credits.server')
    const { getEntitlementFor } = await import('@/features/billing/billing.server')
    const { creditPacks } = await import('./credit-packs')
    const { resolveCreditPack, effectivePlanForCredits } = await import('./credits.core')
    const {
      parseEnabledProviders,
      listAvailableProviders,
    } = await import('@/features/billing/providers/registry')
    const { PROVIDER_IDS } = await import('@/features/billing/providers/catalog')

    const u = await readUser()
    if (!u) throw redirect({ to: '/{-$locale}/login' })

    const db = createDb(env.DB)
    const ent = await getEntitlementFor(db, u.id)
    // `getEntitlementFor` returns the billing plan; the credits grant tier for
    // admins is enterprise, so resolve it through `effectivePlanForCredits`.
    const plan = effectivePlanForCredits(u.role, ent.plan)

    // Read the role straight off the user row: `getEntitlementFor` only answers
    // the subscription question, and `readUser` may serve a cookie-cached role.
    const roleRows = await db.select({ role: user.role }).from(user).where(eq(user.id, u.id))
    const role = roleRows[0]?.role ?? u.role ?? null

    const now = Date.now()
    const account = await getCreditAccount(db, u.id, now, { plan, role })
    const ledger = await listLedger(db, u.id, { page: data.page, pageSize: data.pageSize })

    const billingEnv = env as unknown as BillingEnv
    const available = new Set(listAvailableProviders(billingEnv).map((p) => p.id))
    const enabled = new Set<ProviderId>(parseEnabledProviders(billingEnv.BILLING_PROVIDERS))

    // A provider is offered when it is live (switch + secrets) AND at least one
    // pack has a configured product id that resolves for it.
    const providers: ProviderId[] = []
    for (const id of PROVIDER_IDS) {
      if (!available.has(id)) continue
      const sellsAny = creditPacks.some((pack) => {
        const productId = pack.productIds[id]
        return !!productId && resolveCreditPack(billingEnv, pack, id).ok
      })
      if (sellsAny) providers.push(id)
    }

    // Per-pack errors are operator-actionable and only surface for providers
    // the operator explicitly enabled but that cannot sell this pack.
    const packProviderErrors: { packId: string; errors: string[] }[] = []
    for (const pack of creditPacks) {
      const errors: string[] = []
      for (const id of PROVIDER_IDS) {
        if (!enabled.has(id)) continue
        const productId = pack.productIds[id]
        if (!productId) continue
        const resolved = resolveCreditPack(billingEnv, pack, id)
        if (!resolved.ok) errors.push(resolved.reason)
      }
      if (errors.length > 0) packProviderErrors.push({ packId: pack.id, errors })
    }

    return {
      account,
      ledger,
      packs: creditPacks.map((pack) => ({ ...pack })),
      providers,
      packProviderErrors,
    }
  })

/**
 * The metered demo task: consumes a fixed cost from the caller's account.
 *
 * Returns `{ ok: false, reason: 'insufficient_credits' }` rather than throwing
 * so the page can render a specific inline message instead of a generic error.
 */
export const consumeDemoCredits = createServerFn({ method: 'POST' })
  .handler(async (): Promise<{ ok: true; balance: number } | { ok: false; reason: 'insufficient_credits' }> => {
    const { env } = await import('@/lib/env')
    const { createDb } = await import('@/db/client')
    const { readUser } = await import('@/features/auth/readUser.server')
    const { consumeCredits } = await import('./credits.server')
    const { DEMO_TASK_COST } = await import('./credits.core')

    const u = await readUser()
    if (!u) throw redirect({ to: '/{-$locale}/login' })

    const res = await consumeCredits(
      createDb(env.DB),
      { userId: u.id, cost: DEMO_TASK_COST, ref: null, note: 'demo task' },
      Date.now(),
    )
    if (res.ok) return { ok: true, balance: res.balanceAfter }
    return { ok: false, reason: 'insufficient_credits' }
  })

/**
 * Begin a hosted checkout for one credit pack through one provider.
 *
 * Mirrors `startCheckout`: `resolveCreditPack` is the single authority on
 * "can this vendor sell this pack", and the verdict the page rendered is the
 * verdict here — a hand-crafted POST cannot buy through a provider that is
 * switched off, unconfigured, or not selling the pack.
 */
export const startCreditPurchase = createServerFn({ method: 'POST' })
  .validator((d: { packId: string; provider: string; locale?: string }) => d)
  .handler(async ({ data }): Promise<{ url: string }> => {
    const { env } = await import('@/lib/env')
    const { createDb } = await import('@/db/client')
    const { readUser } = await import('@/features/auth/readUser.server')
    const { packById } = await import('./credit-packs')
    const { resolveCreditPack } = await import('./credits.core')
    const { getBillingProvider } = await import('@/features/billing/providers/registry')
    const { isProviderId } = await import('@/features/billing/providers/catalog')
    // Slice B's credit-checkout entry point (added alongside the credit webhooks).
    const { startCreditCheckout } = await import('@/features/billing/billing.server')

    const u = await readUser()
    const locale = data.locale === 'zh' ? 'zh' : 'en'
    if (!u) throw redirect({ to: '/{-$locale}/login', params: { locale } })

    const pack = packById(data.packId)
    if (!pack) throw new Error(`Unknown credit pack: ${data.packId}`)
    if (!isProviderId(data.provider)) throw new Error(`Unknown payment provider: ${data.provider}`)

    const billingEnv = env as unknown as BillingEnv
    const resolved = resolveCreditPack(billingEnv, pack, data.provider)
    if (!resolved.ok) throw new Error(resolved.reason)

    const base = new URL(env.BETTER_AUTH_URL).origin
    const localePrefix = locale === 'zh' ? '/zh' : ''
    const successUrl = `${base}${localePrefix}/app/credits?purchase=success`
    const cancelUrl = `${base}${localePrefix}/app/credits?purchase=cancel`

    return startCreditCheckout(
      createDb(env.DB),
      getBillingProvider(billingEnv, data.provider),
      u,
      pack.id,
      successUrl,
      cancelUrl,
    )
  })
