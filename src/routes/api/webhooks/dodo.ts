import { createFileRoute } from '@tanstack/react-router'

/**
 * Dodo Payments webhook receiver.
 *
 * Configure in the Dodo dashboard as `https://<your-host>/api/webhooks/dodo`.
 * Dodo follows the Standard Webhooks spec: `webhook-id`, `webhook-timestamp` and
 * `webhook-signature` all participate in verification of the raw body.
 */
import { createWebhookHandler } from '@/features/billing/webhook-handler.server'

const handler = createWebhookHandler('dodo')

export const Route = createFileRoute('/api/webhooks/dodo')({
  server: { handlers: { POST: handler } },
})
