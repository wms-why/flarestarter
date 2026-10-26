import { createServerFn } from '@tanstack/react-start'
import { APP_URL } from '@/lib/brand'

/**
 * canonical / og:url 该用哪个 origin —— 纯函数，便于在 node pool 里测。
 *
 * 优先级：
 *   1. `APP_URL` —— build-time 品牌配置（`src/lib/brand.ts`）。品牌换了域名就该跟着换，
 *      而且它和站上印出来的名字来自同一处配置。
 *   2. `BETTER_AUTH_URL` —— 运行时认证配置。品牌没配时回落到它，这样**改造前就存在的
 *      部署**（只有 BETTER_AUTH_URL）行为一字不变。
 *
 * 「没配」的判定是 `hostname.endsWith('example.com')`：`APP_URL` 的兜底值是模板自己的
 * `https://flarestarter.example.com`，而真实部署不可能用 `example.com`。用后缀而不是
 * 等值比较，是为了让下游把自己默认域名也设成 `*.example.com` 时同样能正确回落。
 */
export function resolveSiteOrigin(appUrl: string, authUrl: string): string {
  const authOrigin = new URL(authUrl).origin
  try {
    const candidate = new URL(appUrl)
    if (candidate.hostname === '' || candidate.hostname.endsWith('example.com')) return authOrigin
    return candidate.origin
  } catch {
    // APP_URL 填错（不是合法 URL）时不要让 head() 挂掉——SEO 标签是装饰性的，
    // 而 head() 抛错会把整页替换成错误页。
    return authOrigin
  }
}

/** 站点根 origin（protocol + host），用于 SEO 的 canonical / hreflang / OG 标签。 */
export const getOrigin = createServerFn({ method: 'GET' }).handler(
  async (): Promise<string> => {
    // Lazy env import (repo convention): keeps cloudflare:workers out of node test graphs.
    const { env } = await import('@/lib/env')
    return resolveSiteOrigin(APP_URL, env.BETTER_AUTH_URL)
  },
)
