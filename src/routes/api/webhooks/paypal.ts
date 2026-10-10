import { createFileRoute } from '@tanstack/react-router'
import { createWebhookHandler } from '@/features/billing/webhook-handler.server'

/**
 * PayPal webhook receiver.
 *
 * Configure in the PayPal dashboard as `https://<your-host>/api/webhooks/paypal`,
 * and store the resulting webhook id as the `PAYPAL_WEBHOOK_ID` secret — the id
 * is part of the verification call, so without it deliveries cannot be trusted.
 *
 * PayPal's signature spans five `paypal-*` headers; see `providers/paypal.ts`.
 */
const handler = createWebhookHandler('paypal')

export const Route = createFileRoute('/api/webhooks/paypal')({
  server: { handlers: { POST: handler } },
})
