/**
 * Dodo Payments webhook signature verification.
 *
 * Dodo follows the [Standard Webhooks](https://www.standardwebhooks.com) scheme,
 * so this is not a vendor-specific HMAC recipe like Creem's — three headers
 * participate instead of one:
 *
 *   - `webhook-id`        — the event's unique id (also our idempotency key)
 *   - `webhook-timestamp` — Unix seconds the delivery was signed at
 *   - `webhook-signature` — one or more space-separated `v1,<base64>` signatures
 *
 * The signed content is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256'd with the
 * *decoded* signing secret (the dashboard hands out `whsec_<base64>`).
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *   1. **The raw body, byte for byte.** The route hands us `request.text()`
 *      before anything parses it; a `JSON.parse` → `JSON.stringify` round trip
 *      upstream produces different bytes and a spurious failure.
 *   2. **The timestamp bound.** A signature stays valid forever otherwise, so a
 *      leaked delivery could be replayed at will. We reject anything outside the
 *      5-minute window the Standard Webhooks libraries use.
 *
 * Split out from the adapter so it is testable in the node pool without a
 * network, mirroring `creem-signature.ts`.
 */

/** How far a delivery's timestamp may drift from our clock. */
export const DODO_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/**
 * Turn the dashboard's signing secret into HMAC key bytes.
 *
 * Dodo (like every Standard Webhooks sender) emits `whsec_<base64>`. A secret
 * with no prefix, or one that is not valid base64, is used verbatim as UTF-8 —
 * that keeps a hand-rolled test/misconfigured secret verifiable rather than
 * throwing inside the request path.
 */
export function decodeDodoSecret(secret: string): Uint8Array<ArrayBuffer> {
  const trimmed = secret.trim()
  const body = trimmed.startsWith('whsec_') ? trimmed.slice('whsec_'.length) : trimmed
  if (body === '') return new TextEncoder().encode(trimmed)
  try {
    const bytes = base64ToBytes(body)
    return bytes.length > 0 ? bytes : new TextEncoder().encode(trimmed)
  } catch {
    return new TextEncoder().encode(trimmed)
  }
}

/**
 * Constant-time string comparison.
 *
 * Length is compared first (it leaks only the length, which is not a secret);
 * everything after folds every XOR into one accumulator so the loop never
 * short-circuits on the first differing character — a per-character early return
 * is the classic timing oracle. The hex twin lives in `creem-signature.ts`; the
 * two are separate because what they compare (base64 vs hex) differs, not how.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export interface DodoVerificationInput {
  /** The untouched request body. */
  rawBody: string
  headers: Record<string, string | null>
  /** The endpoint's signing secret, as issued by the dashboard. */
  secret: string
  /** Injectable clock (Unix seconds) so the replay-window test is deterministic. */
  nowSeconds?: number
}

/**
 * Verify a delivery. `true` only for a fresh, correctly signed body.
 *
 * The header may carry several signatures (`v1,aaa v1,bbb`) during a secret
 * rotation — the old secret stays valid for 24h — so any match is accepted.
 */
export async function verifyDodoSignature(input: DodoVerificationInput): Promise<boolean> {
  const id = input.headers['webhook-id']
  const timestampHeader = input.headers['webhook-timestamp']
  const signatureHeader = input.headers['webhook-signature']
  if (!id || !timestampHeader || !signatureHeader) return false

  // Strict: `Number.parseInt` happily reads "1746198000abc" as a number, and a
  // half-parsed timestamp must not be the thing standing between a replay and
  // the database.
  if (!/^\d+$/.test(timestampHeader)) return false
  const timestamp = Number.parseInt(timestampHeader, 10)
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > DODO_TIMESTAMP_TOLERANCE_SECONDS) return false

  const key = await crypto.subtle.importKey(
    'raw',
    decodeDodoSecret(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${id}.${timestampHeader}.${input.rawBody}`),
  )
  const expected = bytesToBase64(new Uint8Array(mac))

  for (const candidate of signatureHeader.split(' ')) {
    // Each candidate is `v1,<base64>`. Unknown schemes (a future `v2`) are
    // skipped rather than treated as a match.
    const comma = candidate.indexOf(',')
    if (comma === -1) continue
    if (candidate.slice(0, comma) !== 'v1') continue
    if (timingSafeEqual(candidate.slice(comma + 1), expected)) return true
  }
  return false
}

/** The headers a Dodo delivery must carry — exported so the adapter can name them in errors. */
export const DODO_SIGNATURE_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const
