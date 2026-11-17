import { describe, expect, test } from 'vitest'
import {
  DODO_TIMESTAMP_TOLERANCE_SECONDS,
  decodeDodoSecret,
  verifyDodoSignature,
} from '@/features/billing/providers/dodo-signature'

/** A raw key encoded the way the Dodo dashboard hands one out. */
const RAW_KEY = 'dodo-signing-key'
const SECRET = `whsec_${btoa(RAW_KEY)}`

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** Sign the way Dodo does: HMAC-SHA256 over `id.timestamp.body`, base64. */
async function sign(
  { id, timestamp, body }: { id: string; timestamp: string; body: string },
  key = RAW_KEY,
): Promise<string> {
  const imported = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(`${id}.${timestamp}.${body}`))
  return base64(new Uint8Array(mac))
}

async function delivery(overrides: {
  id?: string
  timestamp?: number
  body?: string
  key?: string
  signature?: string
  drop?: readonly string[]
} = {}) {
  const id = overrides.id ?? 'msg_1'
  const timestamp = String(overrides.timestamp ?? Math.floor(Date.now() / 1000))
  const body = overrides.body ?? JSON.stringify({ type: 'payment.succeeded' })
  const signature = overrides.signature ?? `v1,${await sign({ id, timestamp, body }, overrides.key ?? RAW_KEY)}`
  const headers: Record<string, string | null> = {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': signature,
  }
  for (const key of overrides.drop ?? []) delete headers[key]
  return { rawBody: body, headers, secret: SECRET }
}

describe('decodeDodoSecret', () => {
  test('strips the whsec_ prefix and base64-decodes the rest', () => {
    expect(new TextDecoder().decode(decodeDodoSecret(SECRET))).toBe(RAW_KEY)
  })

  test('a secret without the prefix is decoded the same way', () => {
    expect(new TextDecoder().decode(decodeDodoSecret(btoa(RAW_KEY)))).toBe(RAW_KEY)
  })

  test('a secret that is not base64 falls back to its own bytes instead of throwing', () => {
    // A hand-rolled test secret must still be verifiable — throwing inside the
    // request path would turn a misconfiguration into a 500 on every delivery.
    expect(new TextDecoder().decode(decodeDodoSecret('plain-secret'))).toBe('plain-secret')
  })
})

describe('verifyDodoSignature', () => {
  test('accepts a correctly signed, fresh delivery', async () => {
    expect(await verifyDodoSignature(await delivery())).toBe(true)
  })

  test('rejects a tampered body — the signature covers the raw bytes', async () => {
    const d = await delivery({ body: '{"type":"payment.succeeded"}' })
    expect(await verifyDodoSignature({ ...d, rawBody: '{"type":"payment.failed"}' })).toBe(false)
  })

  test('rejects a re-serialized body, which is why the route reads text first', async () => {
    const body = '{"type":"payment.succeeded","data":{"amount":100}}'
    const d = await delivery({ body })
    // Same data, different bytes (whitespace) — exactly the failure mode a
    // `JSON.parse` → `JSON.stringify` round trip before verification causes.
    expect(await verifyDodoSignature({ ...d, rawBody: JSON.stringify(JSON.parse(body), null, 2) })).toBe(false)
  })

  test('rejects a delivery signed with another key', async () => {
    const d = await delivery({ key: 'someone-elses-key' })
    expect(await verifyDodoSignature(d)).toBe(false)
  })

  test('rejects a signature that is not a v1 signature', async () => {
    const d = await delivery()
    const signature = d.headers['webhook-signature']!
    expect(await verifyDodoSignature({ ...d, headers: { ...d.headers, 'webhook-signature': signature.replace('v1,', 'v2,') } })).toBe(false)
  })

  test('accepts any matching v1 signature during a secret rotation', async () => {
    const d = await delivery()
    const valid = d.headers['webhook-signature']!
    expect(await verifyDodoSignature({
      ...d,
      headers: { ...d.headers, 'webhook-signature': `v1,not-a-real-signature ${valid}` },
    })).toBe(true)
  })

  test('rejects a stale delivery so a leaked one cannot be replayed', async () => {
    const stale = Math.floor(Date.now() / 1000) - DODO_TIMESTAMP_TOLERANCE_SECONDS - 1
    const d = await delivery({ timestamp: stale })
    expect(await verifyDodoSignature(d)).toBe(false)
  })

  test('rejects a delivery stamped in the future beyond the tolerance', async () => {
    const future = Math.floor(Date.now() / 1000) + DODO_TIMESTAMP_TOLERANCE_SECONDS + 1
    expect(await verifyDodoSignature(await delivery({ timestamp: future }))).toBe(false)
  })

  test('the timestamp bound is injectable, so the window is exact at the edge', async () => {
    const now = 1_800_000_000
    const edge = await delivery({ timestamp: now - DODO_TIMESTAMP_TOLERANCE_SECONDS })
    expect(await verifyDodoSignature({ ...edge, nowSeconds: now })).toBe(true)
    const past = await delivery({ timestamp: now - DODO_TIMESTAMP_TOLERANCE_SECONDS - 1 })
    expect(await verifyDodoSignature({ ...past, nowSeconds: now })).toBe(false)
  })

  test('a missing header is a rejection, not an exception', async () => {
    for (const header of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      expect(await verifyDodoSignature(await delivery({ drop: [header] })), header).toBe(false)
    }
  })

  test('a non-numeric timestamp is a rejection', async () => {
    const d = await delivery()
    for (const value of ['soon', '', '1746198000abc']) {
      expect(await verifyDodoSignature({ ...d, headers: { ...d.headers, 'webhook-timestamp': value } }), value).toBe(false)
    }
  })
})
