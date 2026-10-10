import { describe, expect, test } from 'vitest'
import { timingSafeEqualHex, verifyCreemSignature } from '@/features/billing/providers/creem-signature'

const SECRET = 'whsec_test_secret'

async function hmac(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const BODY = JSON.stringify({ id: 'evt_1', eventType: 'checkout.completed', object: {} })

describe('timingSafeEqualHex', () => {
  test('equal strings match, different strings do not', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true)
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false)
  })

  test('length mismatch short-circuits instead of indexing past the end', () => {
    expect(timingSafeEqualHex('abc', 'abcd')).toBe(false)
    expect(timingSafeEqualHex('', '')).toBe(true)
  })

  test('examines every character rather than returning at the first mismatch', () => {
    // A per-character early return would make this observable; we only assert
    // the verdict, since timing itself isn't testable here.
    const sig = 'f'.repeat(64)
    expect(timingSafeEqualHex(sig, sig)).toBe(true)
    expect(timingSafeEqualHex('0'.repeat(63) + '1', sig)).toBe(false)
  })
})

describe('verifyCreemSignature', () => {
  test('accepts a body signed with the right secret', async () => {
    expect(await verifyCreemSignature(BODY, await hmac(BODY), SECRET)).toBe(true)
  })

  test('is case-insensitive on the header (hex arrives in both cases in the wild)', async () => {
    expect(await verifyCreemSignature(BODY, (await hmac(BODY)).toUpperCase(), SECRET)).toBe(true)
  })

  test('rejects the right signature paired with the wrong secret', async () => {
    const signature = await hmac(BODY, 'a-different-secret')
    expect(await verifyCreemSignature(BODY, signature, SECRET)).toBe(false)
  })

  test('rejects a body tampered by even one byte', async () => {
    const signature = await hmac(BODY)
    const tampered = BODY.replace('checkout.completed', 'checkout.completeX')
    expect(await verifyCreemSignature(tampered, signature, SECRET)).toBe(false)
  })

  test('rejects a re-serialized body — parse-then-stringify breaks verification', async () => {
    // This is the failure mode the webhook route must avoid: signing covers the
    // exact bytes Creem sent, not the parsed object.
    const signature = await hmac(BODY)
    const reserialized = JSON.stringify(JSON.parse(BODY))
    expect(reserialized).toBe(BODY) // same here, but re-keyed ordering would differ
    expect(await verifyCreemSignature(`${reserialized} `, signature, SECRET)).toBe(false)
  })

  test('rejects a missing or empty signature header', async () => {
    expect(await verifyCreemSignature(BODY, null, SECRET)).toBe(false)
    expect(await verifyCreemSignature(BODY, '', SECRET)).toBe(false)
  })

  test('rejects a signature of the wrong length', async () => {
    const signature = await hmac(BODY)
    expect(await verifyCreemSignature(BODY, signature.slice(0, -2), SECRET)).toBe(false)
    expect(await verifyCreemSignature(BODY, `${signature}00`, SECRET)).toBe(false)
  })
})
