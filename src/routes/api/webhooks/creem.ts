import { createFileRoute } from '@tanstack/react-router'

/**
 * Creem webhook receiver.
 *
 * Configure in the Creem dashboard as `https://<your-host>/api/webhooks/creem`.
 * Signature lives in the `creem-signature` header and covers the raw body.
 */
import { createWebhookHandler } from '@/features/billing/webhook-handler.server'

const handler = createWebhookHandler('creem')

export const Route = createFileRoute('/api/webhooks/creem')({
  server: { handlers: { POST: handler } },
})
