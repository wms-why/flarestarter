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
import { isCreditsEnabled } from './credits-switch'

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
