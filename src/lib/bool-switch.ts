/**
 * Shared vocabulary for env switches that are booleans in string clothing
 * (wrangler can only deliver strings, and secrets/vars both arrive as text).
 *
 * One definition, because two lists drifting apart is how a security switch
 * silently changes meaning: if the boot-time validator kept accepting `false`
 * while the runtime gate stopped recognising it, a typo'd flag would fail
 * startup loudly today and quietly flip the control off tomorrow.
 *
 * Lives in `lib/` as a dependency-free leaf so both the pure env validator
 * (`lib/env-validate.ts`, which by design imports no feature modules) and
 * feature code can read it without either importing the other.
 */

/** Accepted spellings, lowercased and trimmed. Anything else is a typo. */
const VALUES = new Set(['true', 'false', '1', '0', 'on', 'off', 'yes', 'no'])
const OFF = new Set(['false', '0', 'off', 'no'])

/**
 * Read an on/off switch. Returns `null` when the value is not a recognised
 * spelling — callers decide whether that is a hard error (a typo in a mode
 * switch should fail the boot, not guess) or falls back to a default.
 */
export function parseBoolSwitch(raw: string | undefined): boolean | null {
  const v = raw?.trim().toLowerCase() ?? ''
  if (v === '') return null
  if (!VALUES.has(v)) return null
  return !OFF.has(v)
}