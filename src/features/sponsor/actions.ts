import { createServerFn } from '@tanstack/react-start'

export const startSponsorship = createServerFn({ method: 'POST' })
  .validator((d: { mode: 'once' | 'monthly'; amountCents: number; github?: string; message?: string; method?: 'card' | 'wechat' }) => d)
  .handler(async ({ data }): Promise<{ url: string }> => {
    const { env } = await import('@/lib/env')
    if (!env.STRIPE_SECRET_KEY) throw new Error('Sponsorship not configured')
    const { validateAmount, validateGithub, validateMessage } = await import('./amounts')
    const { createSponsorCheckout } = await import('./sponsor.stripe')
    const { isWechatPayEnabled } = await import('./sponsor.config')
    const amountCents = validateAmount(data.amountCents)
    const github = validateGithub(data.github) ?? undefined
    const message = validateMessage(data.message) ?? undefined
    const mode = data.mode === 'monthly' ? 'monthly' : 'once'
    const method = data.method === 'wechat' ? 'wechat' : 'card'
    // The UI only offers WeChat for one-time, but UI gating is bypassable. Letting
    // monthly through would fail at Stripe with a much muddier error.
    if (method === 'wechat') {
      if (!isWechatPayEnabled(env)) throw new Error('WeChat Pay is not enabled')
      if (mode !== 'once') throw new Error('WeChat Pay supports one-time sponsorships only')
    }
    const base = new URL(env.BETTER_AUTH_URL).origin
    return createSponsorCheckout(env, {
      mode,
      method,
      amountCents,
      github,
      message,
      successUrl: `${base}/sponsor?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/sponsor`,
    })
  })

export const getSponsorConfig = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('@/lib/env')
  const { createDb } = await import('@/db/client')
  const { listPublicSponsors } = await import('./sponsor.server')
  const { isWechatPayEnabled } = await import('./sponsor.config')
  const sponsors = await listPublicSponsors(createDb(env.DB))
  return { configured: !!env.STRIPE_SECRET_KEY, wechatEnabled: isWechatPayEnabled(env), sponsors }
})

export const getSponsorManageLink = createServerFn({ method: 'POST' })
  .validator((d: { sessionId: string }) => d)
  .handler(async ({ data }): Promise<{ url: string | null }> => {
    const { env } = await import('@/lib/env')
    if (!env.STRIPE_SECRET_KEY || !data.sessionId) return { url: null }
    const { createPortalLinkForSession } = await import('./sponsor.stripe')
    const base = new URL(env.BETTER_AUTH_URL).origin
    return { url: await createPortalLinkForSession(env, data.sessionId, `${base}/sponsor`) }
  })
