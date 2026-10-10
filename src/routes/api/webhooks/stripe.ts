import { createFileRoute } from '@tanstack/react-router'
import { env } from '@/lib/env'
import { createDb } from '@/db/client'
import { applyDomainEvent, handleWebhook } from '@/features/billing/billing.server'
import { createStripeProvider } from '@/features/billing/providers/stripe'
import { headerBag } from '@/features/billing/payment'
import { translateStripeEvent } from '@/features/billing/entitlement'
import { constructSponsorEvent } from '@/features/sponsor/sponsor.stripe'
import { translateSponsorEvent, isExclusiveSponsorEvent } from '@/features/sponsor/webhook'
import { applySponsorEvent } from '@/features/sponsor/sponsor.server'

/**
 * Stripe webhook receiver — the one route that cannot use the shared
 * `createWebhookHandler`, because sponsorship and product billing share it.
 *
 * Verify once, then branch: sponsorship events are handled here; everything else
 * falls through to billing (reusing the already-verified event).
 */
const handler = async ({ request }: { request: Request }) => {
  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature') ?? ''
  const db = createDb(env.DB)

  let event
  try {
    event = await constructSponsorEvent(env, rawBody, signature)
  } catch {
    return new Response('error', { status: 400 })
  }

  const se = translateSponsorEvent(event)
  if (se) {
    try {
      await applySponsorEvent(db, se, Date.now())
    } catch (err) {
      console.error('[sponsor] webhook handling failed', err)
      return new Response('error', { status: 500 })
    }
    // created/renewed/canceled are verifiably sponsorship-only; refund/dispute
    // events must ALSO reach billing (lifetime-purchase refunds live there).
    if (isExclusiveSponsorEvent(se)) return new Response('ok', { status: 200 })
  }

  const provider = createStripeProvider(env)
  const status = await handleWebhook(
    db,
    'stripe',
    async () => translateStripeEvent(event),   // reuse verified event, no re-parse
    rawBody,
    headerBag(request.headers),
    Date.now(),
    (db, ev, now) => applyDomainEvent(db, ev, now, (id) => provider.cancelSubscription(id)),
  )
  return new Response(status === 200 ? 'ok' : 'error', { status })
}

export const Route = createFileRoute('/api/webhooks/stripe')({
  server: { handlers: { POST: handler } },
})
