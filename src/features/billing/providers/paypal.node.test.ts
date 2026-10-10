import { describe, expect, test, vi } from 'vitest'
import { createPaypalProvider, isSubscriptionPlanId, normalizePaypalEventType, type PaypalEnv } from '@/features/billing/providers/paypal'

const ENV: PaypalEnv = {
  PAYPAL_CLIENT_ID: 'cid',
  PAYPAL_CLIENT_SECRET: 'csecret',
  PAYPAL_WEBHOOK_ID: 'WH-1',
  PAYPAL_ENV: 'sandbox',
}

const APPROVE_LINKS = [
  { rel: 'self', href: 'https://api-m.sandbox.paypal.com/v1/thing' },
  { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=EC-TEST' },
]

/** Records every request so tests can assert on the exact shapes sent. */
function stubFetch(routes: Record<string, { status?: number; json: unknown }>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const raw = typeof init?.body === 'string' ? init.body : undefined
    calls.push({
      url,
      method,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      // The OAuth call is form-encoded, not JSON — keep it verbatim so the test
      // can assert on the exact grant_type payload.
      body: raw && raw.trimStart().startsWith('{') ? JSON.parse(raw) : raw,
    })
    const route = routes[`${method} ${url}`] ?? routes[url]
    if (!route) throw new Error(`unstubbed request: ${method} ${url}`)
    const status = route.status ?? 200
    // A 204 must carry no body or the Response constructor throws.
    if (status === 204) return new Response(null, { status })
    return new Response(JSON.stringify(route.json), { status, headers: { 'Content-Type': 'application/json' } })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

const TOKEN = { 'POST https://api-m.sandbox.paypal.com/v1/oauth2/token': { json: { access_token: 'tok_123' } } }

const PAYPAL_HEADERS = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api-m.sandbox.paypal.com/certs/x.pem',
  'paypal-transmission-id': 'trans-1',
  'paypal-transmission-sig': 'sig-1',
  'paypal-transmission-time': '2026-01-01T00:00:00Z',
}

describe('normalizePaypalEventType', () => {
  test('maps the capture/sale lifecycle onto our vocabulary', () => {
    expect(normalizePaypalEventType('PAYMENT.CAPTURE.COMPLETED')).toBe('purchase.completed')
    expect(normalizePaypalEventType('PAYMENT.SALE.COMPLETED')).toBe('purchase.completed')
    expect(normalizePaypalEventType('PAYMENT.CAPTURE.REFUNDED')).toBe('purchase.refunded')
    expect(normalizePaypalEventType('PAYMENT.CAPTURE.REVERSED')).toBe('purchase.refunded')
  })

  test('maps subscription lifecycle and failures', () => {
    expect(normalizePaypalEventType('BILLING.SUBSCRIPTION.ACTIVATED')).toBe('subscription.upserted')
    expect(normalizePaypalEventType('BILLING.SUBSCRIPTION.RENEWED')).toBe('subscription.upserted')
    expect(normalizePaypalEventType('BILLING.SUBSCRIPTION.CANCELLED')).toBe('subscription.deleted')
    expect(normalizePaypalEventType('BILLING.SUBSCRIPTION.EXPIRED')).toBe('subscription.deleted')
    expect(normalizePaypalEventType('BILLING.SUBSCRIPTION.PAYMENT.FAILED')).toBe('payment.failed')
    expect(normalizePaypalEventType('BILLING.SUBSCRIPTION.SUSPENDED')).toBe('payment.failed')
  })

  test('events we do not act on collapse to ignored', () => {
    expect(normalizePaypalEventType('CHECKOUT.ORDER.APPROVED')).toBe('ignored')
    expect(normalizePaypalEventType('BILLING.SUBSCRIPTION.CREATED')).toBe('ignored')
    expect(normalizePaypalEventType('')).toBe('ignored')
  })
})

describe('isSubscriptionPlanId', () => {
  test('the P- prefix is what routes to the Subscriptions API', () => {
    expect(isSubscriptionPlanId('P-ABC123')).toBe(true)
    expect(isSubscriptionPlanId('PRO-ABC123')).toBe(false)
    expect(isSubscriptionPlanId('prod_abc')).toBe(false)
  })
})

describe('createPaypalProvider — checkout', () => {
  test('a P- id creates a subscription and returns the approve link', async () => {
    const { impl, calls } = stubFetch({
      ...TOKEN,
      'POST https://api-m.sandbox.paypal.com/v1/billing/subscriptions': { json: { id: 'I-BSUB1', links: APPROVE_LINKS } },
    })
    const provider = createPaypalProvider(ENV, impl)
    const { url } = await provider.createCheckoutSession({
      userId: 'u1', userEmail: 'a@b.c', customerId: null, productId: 'P-ABC123',
      mode: 'subscription', successUrl: 'https://app.test/app?checkout=success',
      cancelUrl: 'https://app.test/app?checkout=cancelled', metadata: { userId: 'u1' },
    })
    expect(url).toBe('https://www.sandbox.paypal.com/checkoutnow?token=EC-TEST')

    const sub = calls.find((c) => c.url.endsWith('/v1/billing/subscriptions'))!
    expect(sub.body).toMatchObject({
      plan_id: 'P-ABC123',
      subscriber: { email_address: 'a@b.c' },
      // custom_id is the only handle that ties the webhook back to our user.
      custom_id: 'u1',
      application_context: { return_url: 'https://app.test/app?checkout=success', cancel_url: 'https://app.test/app?checkout=cancelled' },
    })
    // Idempotency header on a money-moving create call.
    expect(sub.headers['PayPal-Request-Id']).toBeTruthy()
    expect(sub.headers.Authorization).toBe('Bearer tok_123')
  })

  test('OAuth uses client-credentials basic auth', async () => {
    const { impl, calls } = stubFetch({
      ...TOKEN,
      'POST https://api-m.sandbox.paypal.com/v1/billing/subscriptions': { json: { id: 'I-1', links: APPROVE_LINKS } },
    })
    await createPaypalProvider(ENV, impl).createCheckoutSession({
      userId: 'u1', userEmail: 'a@b.c', customerId: null, productId: 'P-A', mode: 'subscription',
      successUrl: 'https://app.test/s', cancelUrl: 'https://app.test/c', metadata: { userId: 'u1' },
    })
    const token = calls[0]
    expect(token.url).toContain('/v1/oauth2/token')
    expect(token.body).toBe('grant_type=client_credentials')
    expect(token.headers.Authorization).toBe(`Basic ${btoa('cid:csecret')}`)
  })

  test('a response with no approve link fails loudly rather than redirecting nowhere', async () => {
    const { impl } = stubFetch({
      ...TOKEN,
      'POST https://api-m.sandbox.paypal.com/v1/billing/subscriptions': { json: { id: 'I-1', links: [{ rel: 'self', href: 'x' }] } },
    })
    await expect(createPaypalProvider(ENV, impl).createCheckoutSession({
      userId: 'u1', userEmail: 'a@b.c', customerId: null, productId: 'P-A', mode: 'subscription',
      successUrl: 'https://app.test/s', cancelUrl: 'https://app.test/c', metadata: { userId: 'u1' },
    })).rejects.toThrow(/approve link/)
  })

  test('live mode talks to api-m.paypal.com', async () => {
    const { impl, calls } = stubFetch({
      'POST https://api-m.paypal.com/v1/oauth2/token': { json: { access_token: 'live_tok' } },
      'POST https://api-m.paypal.com/v1/billing/subscriptions': { json: { id: 'I-1', links: APPROVE_LINKS } },
    })
    await createPaypalProvider({ ...ENV, PAYPAL_ENV: 'live' }, impl).createCheckoutSession({
      userId: 'u1', userEmail: 'a@b.c', customerId: null, productId: 'P-A', mode: 'subscription',
      successUrl: 'https://app.test/s', cancelUrl: 'https://app.test/c', metadata: { userId: 'u1' },
    })
    expect(calls.every((c) => c.url.includes('api-m.paypal.com'))).toBe(true)
  })

  test('portal is unavailable — the account page offers in-app cancel instead', () => {
    expect(createPaypalProvider(ENV).supportsPortal).toBe(false)
  })
})

describe('createPaypalProvider — webhook verification', () => {
  const event = {
    id: 'WH-EVT-1',
    event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
    create_time: '2026-01-01T00:00:00Z',
    resource: { id: 'I-SUB1', plan_id: 'P-ABC', custom_id: 'u1', billing_info: { next_billing_time: '2026-02-01T00:00:00Z' } },
  }
  const body = JSON.stringify(event)

  function routes(verification: { status?: number; json: unknown }) {
    return {
      ...TOKEN,
      'POST https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature': verification,
    }
  }

  test('forwards all five headers, the webhook id, and the parsed event', async () => {
    const { impl, calls } = stubFetch(routes({ json: { verification_status: 'SUCCESS' } }))
    await createPaypalProvider(ENV, impl).parseWebhook(body, PAYPAL_HEADERS)
    const verify = calls.find((c) => c.url.includes('verify-webhook-signature'))!
    expect(verify.body).toMatchObject({
      auth_algo: 'SHA256withRSA',
      cert_url: 'https://api-m.sandbox.paypal.com/certs/x.pem',
      transmission_id: 'trans-1',
      transmission_sig: 'sig-1',
      transmission_time: '2026-01-01T00:00:00Z',
      webhook_id: 'WH-1',
      webhook_event: event,
    })
  })

  test('a SUCCESS verdict normalizes into an upsert carrying userId and period end', async () => {
    const { impl } = stubFetch(routes({ json: { verification_status: 'SUCCESS' } }))
    const out = await createPaypalProvider(ENV, impl).parseWebhook(body, PAYPAL_HEADERS)
    expect(out).toEqual({
      type: 'subscription.upserted',
      eventId: 'WH-EVT-1',
      providerId: 'paypal',
      userId: 'u1',
      customerId: null,
      subscriptionId: 'I-SUB1',
      status: 'active',
      plan: null,
      productId: 'P-ABC',
      currentPeriodEnd: Date.parse('2026-02-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      occurredAt: Date.parse('2026-01-01T00:00:00Z'),
    })
  })

  test('a non-SUCCESS verdict throws, and no verification is skipped', async () => {
    const { impl } = stubFetch(routes({ json: { verification_status: 'FAILURE' } }))
    await expect(createPaypalProvider(ENV, impl).parseWebhook(body, PAYPAL_HEADERS)).rejects.toThrow(/verification failed/)
  })

  test('a 5xx from the verify endpoint throws a distinct error so routes can answer 502 and let PayPal retry', async () => {
    const { impl } = stubFetch(routes({ status: 503, json: {} }))
    await expect(createPaypalProvider(ENV, impl).parseWebhook(body, PAYPAL_HEADERS))
      .rejects.toThrow(/verify-webhook-signature call failed \(503\)/)
  })

  test('missing any of the five headers fails before we spend a token mint', async () => {
    const { impl, calls } = stubFetch(routes({ json: { verification_status: 'SUCCESS' } }))
    for (const key of Object.keys(PAYPAL_HEADERS)) {
      const partial = { ...PAYPAL_HEADERS, [key]: null }
      await expect(createPaypalProvider(ENV, impl).parseWebhook(body, partial)).rejects.toThrow(/Incomplete PayPal signature headers/)
    }
    expect(calls).toHaveLength(0)
  })

  test('an event with no custom_id cannot be attributed and is ignored', async () => {
    const { impl } = stubFetch(routes({ json: { verification_status: 'SUCCESS' } }))
    const anonymous = JSON.stringify({ ...event, resource: { id: 'I-SUB1', plan_id: 'P-ABC' } })
    expect(await createPaypalProvider(ENV, impl).parseWebhook(anonymous, PAYPAL_HEADERS)).toEqual({ type: 'ignored', eventId: 'WH-EVT-1' })
  })

  test('an ACTIVATED event grants access — a hardcoded status here would revoke it', async () => {
    const { impl } = stubFetch(routes({ json: { verification_status: 'SUCCESS' } }))
    const out = await createPaypalProvider(ENV, impl).parseWebhook(body, PAYPAL_HEADERS)
    expect(out.type).toBe('subscription.upserted')
    expect(out).toMatchObject({ status: 'active' })
  })

  test('a CANCELLED event revokes access', async () => {
    const { impl } = stubFetch(routes({ json: { verification_status: 'SUCCESS' } }))
    const cancelled = JSON.stringify({ ...event, event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: 'I-SUB1', custom_id: 'u1' } })
    expect(await createPaypalProvider(ENV, impl).parseWebhook(cancelled, PAYPAL_HEADERS))
      .toMatchObject({ type: 'subscription.deleted', status: 'canceled' })
  })

  test('a SUSPENDED event surfaces as a payment failure, not a cancellation', async () => {
    const { impl } = stubFetch(routes({ json: { verification_status: 'SUCCESS' } }))
    const suspended = JSON.stringify({ ...event, event_type: 'BILLING.SUBSCRIPTION.SUSPENDED', resource: { id: 'I-SUB1', custom_id: 'u1' } })
    expect((await createPaypalProvider(ENV, impl).parseWebhook(suspended, PAYPAL_HEADERS)).type).toBe('payment.failed')
  })

  test('unrelated event types are ignored without touching the resource', async () => {
    const { impl } = stubFetch(routes({ json: { verification_status: 'SUCCESS' } }))
    const approved = JSON.stringify({ id: 'WH-EVT-2', event_type: 'CHECKOUT.ORDER.APPROVED', resource: {} })
    expect(await createPaypalProvider(ENV, impl).parseWebhook(approved, PAYPAL_HEADERS)).toEqual({ type: 'ignored', eventId: 'WH-EVT-2' })
  })
})

describe('createPaypalProvider — cancel', () => {
  test('204 resolves; a 404 is treated as already-gone rather than an error', async () => {
    const ok = stubFetch({ ...TOKEN, 'POST https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-1/cancel': { status: 204, json: {} } })
    await expect(createPaypalProvider(ENV, ok.impl).cancelSubscription('I-1')).resolves.toBeUndefined()

    const gone = stubFetch({ ...TOKEN, 'POST https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-1/cancel': { status: 404, json: {} } })
    await expect(createPaypalProvider(ENV, gone.impl).cancelSubscription('I-1')).resolves.toBeUndefined()
  })

  test('a real failure propagates', async () => {
    const { impl } = stubFetch({ ...TOKEN, 'POST https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-1/cancel': { status: 500, json: {} } })
    await expect(createPaypalProvider(ENV, impl).cancelSubscription('I-1')).rejects.toThrow(/cancel-subscription failed \(500\)/)
  })
})
