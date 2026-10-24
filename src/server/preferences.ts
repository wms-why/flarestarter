import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'

export interface Preferences {
  theme: 'light' | 'dark'
  /** 积分系统总开关（CREDITS_ENABLED）。放在这个 server fn 里返回，是因为
   *  __root 路由同时打进客户端包——在 loader 里直接 import `@/lib/env` 会把
   *  `cloudflare:workers` 拉进浏览器构建。 */
  creditsEnabled: boolean
  /** true = 用户显式选过主题（cookie 在）；false = theme 只是服务端回退值，
   *  客户端应继续跟随系统（boot script / next-themes system），谁也不许把回退值固化成 cookie。 */
  themeFromCookie: boolean
}

export const getPreferences = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Preferences> => {
    // Theme resolution: explicit cookie > system preference > dark (brand default).
    // The server only sees the cookie; for cookie-less visitors a pre-paint inline
    // script in __root flips to light when `prefers-color-scheme: light` — so the
    // SSR fallback here stays dark and first-time visitors follow their OS.
    const cookie = getCookie('theme')
    const themeFromCookie = cookie === 'light' || cookie === 'dark'
    const { env } = await import('@/lib/env')
    const { isCreditsEnabled } = await import('@/features/credits/credits-switch')
    return {
      theme: cookie === 'light' ? 'light' : 'dark',
      themeFromCookie,
      creditsEnabled: isCreditsEnabled(env),
    }
  },
)
