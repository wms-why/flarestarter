/**
 * Unit tests for the GA4 loader (pure DOM-free logic, fake `window`/`document`).
 *
 * The module-level `initialized` flag means every test needs a fresh copy of
 * the module — hence the dynamic imports.
 */
import { test, expect, vi, afterEach } from 'vitest'

interface FakeScript {
  id: string
  async: boolean
  src: string
}

function setupDom() {
  const scripts: FakeScript[] = []
  const document = {
    title: 'Test page',
    getElementById: (id: string) => scripts.find((s) => s.id === id) ?? null,
    createElement: () => ({ id: '', async: false, src: '' }) as FakeScript,
    head: {
      appendChild: (el: FakeScript) => {
        scripts.push(el)
      },
    },
  }
  const window = {
    dataLayer: undefined as unknown[] | undefined,
    gtag: undefined as ((...args: unknown[]) => void) | undefined,
    location: { href: 'https://example.com/pricing?plan=pro', pathname: '/pricing', search: '?plan=pro' },
  }
  globalThis.window = window as unknown as Window & typeof globalThis
  globalThis.document = document as unknown as Document
  return { scripts, window }
}

/** The queued gtag calls, as plain arrays. */
function calls(window: { dataLayer?: unknown[] }): unknown[][] {
  return (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>))
}

afterEach(() => {
  vi.resetModules()
  delete (globalThis as { window?: unknown }).window
  delete (globalThis as { document?: unknown }).document
})

test('initGa loads gtag.js and configures it without an automatic page_view', async () => {
  const { scripts, window } = setupDom()
  const { initGa } = await import('./ga-loader')

  initGa('G-TEST123')

  expect(scripts).toHaveLength(1)
  expect(scripts[0].src).toBe('https://www.googletagmanager.com/gtag/js?id=G-TEST123')
  expect(scripts[0].async).toBe(true)

  const queued = calls(window)
  expect(queued[0][0]).toBe('js') // gtag('js', new Date())
  expect(queued[1][0]).toBe('config')
  expect(queued[1][1]).toBe('G-TEST123')
  expect(queued[1][2]).toEqual({ send_page_view: false }) // the app sends page_view itself
})

test('initGa is idempotent — a route change must not queue a second config', async () => {
  const { scripts, window } = setupDom()
  const { initGa } = await import('./ga-loader')

  initGa('G-TEST123')
  initGa('G-TEST123')

  expect(scripts).toHaveLength(1)
  expect(calls(window).filter((c) => c[0] === 'config')).toHaveLength(1)
})

test('initGa does not configure a tag that is already in the page', async () => {
  const { scripts, window } = setupDom()
  // e.g. the dev server hot-reloaded the module — the tag is already there.
  scripts.push({ id: 'ga4-loader', async: true, src: 'https://www.googletagmanager.com/gtag/js?id=G-OLD' })
  const { initGa } = await import('./ga-loader')

  initGa('G-TEST123')

  expect(scripts).toHaveLength(1) // no second script tag
  expect(calls(window)).toHaveLength(0) // and no second config
})

test('trackPageView reports the current URL', async () => {
  const { window } = setupDom()
  const { initGa, trackPageView } = await import('./ga-loader')

  initGa('G-TEST123')
  trackPageView()

  const event = calls(window).find((c) => c[0] === 'event')
  expect(event).toBeDefined()
  expect(event?.[0]).toBe('event')
  expect(event?.[1]).toBe('page_view')
  expect(event?.[2]).toEqual({
    page_title: 'Test page',
    page_location: 'https://example.com/pricing?plan=pro',
    page_path: '/pricing?plan=pro',
  })
})
