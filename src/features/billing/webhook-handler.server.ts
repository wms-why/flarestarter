import { headerBag } from './payment'
import { getBillingProvider, type BillingEnv } from './providers/registry'
import type { ProviderId } from './providers/catalog'
import type { DomainEvent } from './entitlement'
import { applyDomainEvent, handleWebhook } from './billing.server'

/**
 * Shared webhook skeleton for every vendor.
 *
 * The four routes differ only in *which* provider verifies the delivery; the
 * ordering constraints that actually bite are identical, so they live here once:
 *
 *   1. **Read the raw body before anything parses it.** Waffo and Creem sign the
 *      exact bytes they sent, so a `JSON.parse` → `JSON.stringify` round trip
 *      upstream of verification produces a spurious failure. This is the single
 *      most common way to break a webhook integration.
 *   2. **Bound the body size.** Signature verification is CPU-bound work over
 *      attacker-controlled input.
 *   3. **Separate "bad signature" from "vendor is down".** A vendor outage must
 *      answer 5xx so they retry; answering 400 would discard a real payment event.
 */
const MAX_WEBHOOK_BODY_BYTES = 1_000_000

/**
 * Build the POST handler for one vendor's webhook route.
 *
 * Lives in a `.server.ts` module so the bundler keeps it — and everything it
 * reaches (vendor SDKs, `cloudflare:workers`) — out of the client bundle by
 * construction rather than by convention. Only server route handlers may import it.
 */
export function createWebhookHandler(providerId: ProviderId) {
  return async function handle({ request }: { request: Request }): Promise<Response> {
    // Lazy, matching the rest of the feature's server modules.
    const { env } = await import('@/lib/env')
    const { createDb } = await import('@/db/client')
    // Cheap pre-read: reject an obviously oversized declared body before we read
    // it into memory at all.
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > MAX_WEBHOOK_BODY_BYTES) return new Response('payload too large', { status: 413 })

    // MUST be the untouched body — see note 1 above.
    const rawBody = await request.text()
    if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) return new Response('payload too large', { status: 413 })

    let provider
    try {
      provider = getBillingProvider(env as unknown as BillingEnv, providerId)
    } catch {
      // The Worker was deployed without this provider's secrets, or the provider
      // is switched off. There is nothing to verify against, so this delivery can
      // never be authenticated — do not pretend otherwise.
      return new Response('provider not configured', { status: 503 })
    }

    let event: DomainEvent
    try {
      event = await provider.parseWebhook(rawBody, headerBag(request.headers))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A 5xx from the vendor's own verification endpoint is an outage, not a
      // forgery — 502 makes them retry instead of us dropping the event.
      const vendorDown = /verify-webhook-signature call failed/.test(message)
      if (vendorDown) {
        console.error(`[billing] ${providerId} verification endpoint unavailable`, err)
        return new Response('upstream unavailable', { status: 502 })
      }
      console.error(`[billing] ${providerId} webhook rejected`, message)
      return new Response('invalid signature', { status: vendorIdIsUnauthorized(err) ? 401 : 400 })
    }

    const resolved = event
    const status = await handleWebhook(
      createDb(env.DB),
      providerId,
      async () => resolved,
      rawBody,
      {},
      Date.now(),
      // Wire this vendor's cancel into apply so a one-time purchase can stop a
      // live subscription instead of leaving the buyer on two concurrent plans.
      // Using the provider that verified *this* delivery means a Stripe event
      // can never call Waffo's cancel API.
      (db, ev, now) => applyDomainEvent(db, ev, now, (id) => provider.cancelSubscription(id)),
    )
    return new Response(status === 200 ? 'ok' : 'error', { status })
  }
}

/** Some vendors report a missing signature header distinctly; answer 401 for those. */
function vendorIdIsUnauthorized(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /Missing|incomplete/i.test(message)
}
