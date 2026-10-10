/**
 * Creem webhook signature verification.
 *
 * HMAC-SHA256 over the **raw request body bytes**, hex-encoded, compared
 * against the `creem-signature` header. Split out from the adapter so it can be
 * exercised in the node test pool without an SDK client or a network.
 */

/** Hex-encode raw bytes without `Buffer` (not in the workers-types surface). */
function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Constant-time hex comparison.
 *
 * Length is compared first and returns early — that leaks only the signature
 * length, which is not a secret. Everything after that folds the XOR of every
 * character into one accumulator so the loop never short-circuits on the first
 * differing byte (a per-character early return is the classic timing oracle).
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Verify a Creem delivery. Returns `true` only for a body that matches the
 * secret under `creem-signature`.
 *
 * The caller MUST pass the body verbatim: Creem signs the exact bytes it sent,
 * so `JSON.parse` → `JSON.stringify` before this call produces a different byte
 * sequence and a spurious failure.
 */
export async function verifyCreemSignature(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  return timingSafeEqualHex(toHex(new Uint8Array(mac)), signature.toLowerCase())
}
