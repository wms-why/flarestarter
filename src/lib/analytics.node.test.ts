import { test, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

test('GA is off when no measurement id was configured', async () => {
  const { GA_MEASUREMENT_ID, GA_ENABLED } = await import('./analytics')
  expect(GA_MEASUREMENT_ID).toBe('')
  expect(GA_ENABLED).toBe(false)
})

test('GA is on when the build was configured with a measurement id', async () => {
  vi.stubEnv('GA_MEASUREMENT_ID', 'G-TEST123')
  vi.resetModules()
  const { GA_MEASUREMENT_ID, GA_ENABLED } = await import('./analytics')
  expect(GA_MEASUREMENT_ID).toBe('G-TEST123')
  expect(GA_ENABLED).toBe(true)
})
