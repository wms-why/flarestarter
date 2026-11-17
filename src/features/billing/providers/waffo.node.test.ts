import { describe, expect, test } from 'vitest'
import { WebhookEventType } from '@waffo/pancake-ts'
import { base64ToUtf8, normalizeWaffoEventType, resolvePrivateKey, resolveWebhookPublicKey, type WaffoEnv } from '@/features/billing/providers/waffo'

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqh\nkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'
const ENV: WaffoEnv = {
  WAFFO_MERCHANT_ID: 'MER_abc',
  WAFFO_PRIVATE_KEY: PEM,
  WAFFO_WEBHOOK_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
}

describe('base64ToUtf8', () => {
  test('round-trips multi-byte characters, not just ASCII', () => {
    // A PEM is ASCII, but `atob` yields a binary string — decoding it without
    // the TextDecoder round-trip corrupts any byte above 0x7f.
    const original = 'clé-privée-密钥'
    expect(base64ToUtf8(btoa(unescape(encodeURIComponent(original))))).toBe(original)
  })

  test('round-trips a PEM', () => {
    expect(base64ToUtf8(btoa(PEM))).toBe(PEM)
  })
})

describe('resolvePrivateKey', () => {
  test('accepts a raw PEM', () => {
    expect(resolvePrivateKey(ENV)).toBe(PEM)
  })

  test('unescapes a single-line \\n PEM', () => {
    const escaped = ENV.WAFFO_PRIVATE_KEY!.replace(/\n/g, '\\n')
    expect(resolvePrivateKey({ ...ENV, WAFFO_PRIVATE_KEY: escaped })).toBe(PEM)
  })

  test('prefers the base64 form when both are set — it survives CI secret round-trips', () => {
    const resolved = resolvePrivateKey({ ...ENV, WAFFO_PRIVATE_KEY_BASE64: btoa(PEM) })
    expect(resolved).toBe(PEM)
  })

  test('throws a pointed error when neither is set', () => {
    expect(() => resolvePrivateKey({ ...ENV, WAFFO_PRIVATE_KEY: undefined })).toThrow(/missing WAFFO_PRIVATE_KEY/)
  })

  test('throws when the base64 value is not base64', () => {
    expect(() => resolvePrivateKey({ ...ENV, WAFFO_PRIVATE_KEY_BASE64: 'not base64 !!!' })).toThrow(/not valid base64/)
  })
})

describe('resolveWebhookPublicKey', () => {
  test('unescapes and returns the key', () => {
    expect(resolveWebhookPublicKey({ ...ENV, WAFFO_WEBHOOK_PUBLIC_KEY: 'a\\nb' })).toBe('a\nb')
  })

  test('is mandatory — without it the SDK would fall back to its bundled keypair', () => {
    expect(() => resolveWebhookPublicKey({ ...ENV, WAFFO_WEBHOOK_PUBLIC_KEY: '' })).toThrow(/missing WAFFO_WEBHOOK_PUBLIC_KEY/)
  })
})

describe('normalizeWaffoEventType', () => {
  test('order and refund events', () => {
    expect(normalizeWaffoEventType(WebhookEventType.OrderCompleted)).toBe('purchase.completed')
    expect(normalizeWaffoEventType(WebhookEventType.RefundSucceeded)).toBe('purchase.refunded')
  })

  test('subscription lifecycle', () => {
    expect(normalizeWaffoEventType(WebhookEventType.SubscriptionActivated)).toBe('subscription.upserted')
    expect(normalizeWaffoEventType(WebhookEventType.SubscriptionPaymentSucceeded)).toBe('subscription.upserted')
    // Cancelling is not yet cancelled: access lasts to the end of the period.
    expect(normalizeWaffoEventType(WebhookEventType.SubscriptionCanceling)).toBe('subscription.upserted')
    expect(normalizeWaffoEventType(WebhookEventType.SubscriptionCanceled)).toBe('subscription.deleted')
    expect(normalizeWaffoEventType(WebhookEventType.SubscriptionPastDue)).toBe('payment.failed')
  })

  // SDK 0.28 split the old catch-all `subscription.updated` into these. Every
  // one of them still means "here is a newer snapshot of a live subscription",
  // so dropping any of them would freeze the row at its previous state.
  test('the 0.28 lifecycle split (renewed / recovered / plan change / uncancel) all upsert', () => {
    for (const event of [
      WebhookEventType.SubscriptionRenewed,
      WebhookEventType.SubscriptionRecovered,
      WebhookEventType.SubscriptionPlanChanged,
      WebhookEventType.SubscriptionPlanChangeScheduled,
      WebhookEventType.SubscriptionUncanceled,
    ]) {
      expect(normalizeWaffoEventType(event), event).toBe('subscription.upserted')
    }
  })

  test('failures that change no entitlement are ignored, not applied as a snapshot', () => {
    // A refused plan change and a refused refund leave the subscription exactly
    // as it was; treating either as an upsert would only re-stamp stale state.
    expect(normalizeWaffoEventType(WebhookEventType.SubscriptionPlanChangeFailed)).toBe('ignored')
    expect(normalizeWaffoEventType(WebhookEventType.RefundFailed)).toBe('ignored')
  })

  test('unknown vendor events collapse to ignored', () => {
    expect(normalizeWaffoEventType('order.something_new')).toBe('ignored')
    expect(normalizeWaffoEventType('')).toBe('ignored')
  })
})
