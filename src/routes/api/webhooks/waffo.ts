import { createFileRoute } from '@tanstack/react-router'
import { createWebhookHandler } from '@/features/billing/webhook-handler.server'

/**
 * Waffo webhook receiver.
 *
 * Configure in the Waffo dashboard as `https://<your-host>/api/webhooks/waffo`.
 * Signature lives in the `x-waffo-signature` header and covers the raw body.
 */
const handler = createWebhookHandler('waffo')

export const Route = createFileRoute('/api/webhooks/waffo')({
  server: { handlers: { POST: handler } },
})
