import { en, type Dict } from './dictionaries/en'
import { zh } from './dictionaries/zh'
import { APP_NAME } from '@/lib/brand'

export const locales = ['en', 'zh'] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = 'en'

export const dictionaries: Record<Locale, Dict> = { en, zh }

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value)
}

type Params = Record<string, string | number>

/**
 * 全局插值参数：`{app}` 在**所有**文案里解析成当前构建的品牌名。
 *
 * 为什么放在 translate() 而不是每个调用点：品牌名出现在几十条文案里，
 * 每条都记得传 `{ app: APP_NAME }` 是不可维护的，漏一条就渲染出字面的
 * `{app}`。放在这里，下游改 `.env` 一处，全站生效。
 */
const GLOBAL_PARAMS: Params = { app: APP_NAME }

/**
 * 把一个文案模板里的 `{var}` 替换成参数值。
 *
 * 独立成函数（而不是只存在于 `translate()` 里）是因为还有一类文案不走 i18n 字典
 * 却同样要嵌品牌名——例如套餐的 `LocalizedText`（`features/billing/plans.ts`）。
 * 让它们调用 `translate()` 是不行的（那个函数的入参是完整的 `Dict`），而各自再实现
 * 一遍替换则会让 `{app}` 的语义分叉。
 *
 * `{app}` 来自全局参数，调用点显式传的同名参数可以覆盖它。
 * 未知占位符**原样保留**（`{unknown}`）——宁可露出占位符，也不要静默吞掉排查线索。
 */
export function interpolate(value: string, params?: Params): string {
  const merged: Params = { ...GLOBAL_PARAMS, ...params }
  return value.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in merged ? String(merged[name]) : `{${name}}`,
  )
}

/** 按点路径取文案；缺失回退 key；支持 {var} 插值（`{app}` 缺省可用）。 */
export function translate(dict: Dict, key: string, params?: Params): string {
  const value = key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in acc) return (acc as Record<string, unknown>)[part]
    return undefined
  }, dict)
  if (typeof value !== 'string') return key
  // 注意这里**不能**提前 `if (!params) return value` 返回：`common.appName` 这类不传参的
  // 调用同样要拿到 `{app}` 的替换结果，否则整站会渲染出字面的 `{app}`。
  return interpolate(value, params)
}

/** 从完整 href 上剥掉冗余的 /en 前缀，保留 query 和 hash——
 *  规范化重定向用（`/en/pricing?ref=x` → `/pricing?ref=x`）。 */
export function stripDefaultLocalePrefix(href: string): string {
  const stripped = href.replace(/^\/en(?=[/?#]|$)/, '')
  if (stripped === '') return '/'
  if (stripped.startsWith('?') || stripped.startsWith('#')) return `/${stripped}`
  return stripped
}

/** en 无前缀；其余 locale 加 /{locale} 前缀。 */
export function localizePath(locale: Locale, path: string): string {
  const clean = path === '/' ? '' : path
  if (locale === defaultLocale) return clean || '/'
  return `/${locale}${clean}` || `/${locale}`
}

/** SSR 语言协商：cookie 优先，其次 Accept-Language，最后默认。 */
export function negotiateLocale(
  cookieLocale: string | undefined,
  acceptLanguage: string | null,
): Locale {
  if (isLocale(cookieLocale)) return cookieLocale
  if (acceptLanguage) {
    for (const part of acceptLanguage.split(',')) {
      const tag = part.split(';')[0].trim().toLowerCase()
      const base = tag.split('-')[0]
      if (isLocale(base)) return base
    }
  }
  return defaultLocale
}
