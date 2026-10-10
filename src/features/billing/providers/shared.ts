/**
 * Vendors disagree on how they express "the end of the paid period":
 *
 *   - Waffo sends a date-only ISO string (`"2026-05-01"`) — treated as UTC
 *     midnight so the rendered date matches what the buyer's calendar shows.
 *   - PayPal sends a full ISO 8601 timestamp with offset — `Date.parse` copes.
 *   - Creem sends an ISO datetime on the subscription object.
 *
 * Anything else is rejected. `Date.parse` is lenient enough to happily read
 * `"May 1 2026"`, and a wrong period end is not a cosmetic bug — it is the
 * renewal date the buyer is shown. Returns `undefined` so the caller drops the
 * field instead of writing `null` and making "unknown" indistinguishable from
 * "the vendor said no".
 */
export function toEpochMs(value: string | number | null | undefined): number | undefined {
  if (value == null) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const trimmed = value.trim()
  // ISO date, optionally followed by a time component and zone.
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) return undefined
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
  const ms = dateOnly ? Date.parse(`${trimmed}T00:00:00Z`) : Date.parse(trimmed)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Creem's polymorphic relation fields come back either as a bare id string or
 * as the expanded object, depending on the endpoint and event. Both shapes have
 * to resolve to an id.
 */
export function readPolymorphicId(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id
    return typeof id === 'string' ? id : null
  }
  return null
}
