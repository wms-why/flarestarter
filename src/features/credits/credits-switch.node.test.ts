/**
 * The `CREDITS_ENABLED` master switch — pure, node-testable.
 *
 * The switch decides whether *any* credits surface renders (routes, nav, cards,
 * admin stats). What matters for a feature flag is that every spelling the
 * operator could reasonably write behaves predictably and that the default is
 * the safe one: an absent or unrecognised value must hide the feature, never
 * half-show it.
 */
import { describe, expect, test } from 'vitest'
import { assertCreditsEnabled, isCreditsEnabled } from './credits-switch'

describe('isCreditsEnabled', () => {
  test('is off when the var is unset — a fresh clone shows no credits UI', () => {
    expect(isCreditsEnabled({})).toBe(false)
    expect(isCreditsEnabled({ CREDITS_ENABLED: undefined })).toBe(false)
  })

  test('is off for a blank value — wrangler delivers unset vars as empty strings', () => {
    expect(isCreditsEnabled({ CREDITS_ENABLED: '' })).toBe(false)
    expect(isCreditsEnabled({ CREDITS_ENABLED: '   ' })).toBe(false)
  })

  test('is on for every accepted truthy spelling', () => {
    for (const v of ['true', 'TRUE', 'True', '1', 'on', 'ON', 'yes', ' yes ']) {
      expect(isCreditsEnabled({ CREDITS_ENABLED: v }), v).toBe(true)
    }
  })

  test('is off for every accepted falsy spelling', () => {
    for (const v of ['false', 'FALSE', '0', 'off', 'no']) {
      expect(isCreditsEnabled({ CREDITS_ENABLED: v }), v).toBe(false)
    }
  })

  test('an unrecognised value counts as off — boot validation rejects it, but never guess "on"', () => {
    for (const v of ['ture', 'maybe', 'enabled', '2']) {
      expect(isCreditsEnabled({ CREDITS_ENABLED: v }), v).toBe(false)
    }
  })
})

describe('assertCreditsEnabled', () => {
  test('throws when the feature is off — hiding the UI is not a security boundary', () => {
    expect(() => assertCreditsEnabled({})).toThrow(/not enabled/)
    expect(() => assertCreditsEnabled({ CREDITS_ENABLED: '' })).toThrow(/not enabled/)
    expect(() => assertCreditsEnabled({ CREDITS_ENABLED: 'false' })).toThrow(/not enabled/)
  })

  test('is silent when the feature is on', () => {
    expect(() => assertCreditsEnabled({ CREDITS_ENABLED: 'true' })).not.toThrow()
    expect(() => assertCreditsEnabled({ CREDITS_ENABLED: '1' })).not.toThrow()
  })

  test('agrees with isCreditsEnabled on every input', () => {
    // The two must never disagree, or a surface would be rendered while its
    // endpoint refuses (or vice versa).
    for (const v of [undefined, '', '  ', 'true', '1', 'on', 'yes', 'false', '0', 'off', 'no', 'ture']) {
      const e = { CREDITS_ENABLED: v }
      expect(isCreditsEnabled(e)).toBe(!(() => { try { assertCreditsEnabled(e); return false } catch { return true } })())
    }
  })
})
