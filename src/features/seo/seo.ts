import { locales, defaultLocale, localizePath, type Locale } from '@/features/i18n/locale'

const PUBLIC_PATHS = ['/', '/pricing', '/changelog', '/sponsor', '/waitlist'] as const

// Open Graph 要求 language_TERRITORY 形态（en_US），裸语言码会被严格解析器忽略。
const OG_LOCALE: Record<Locale, string> = { en: 'en_US', zh: 'zh_CN' }

export function buildRobots(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /*/app',
    'Disallow: /app',
    'Disallow: /*/admin',
    'Disallow: /admin',
    'Disallow: /api',
    `Sitemap: ${origin}/sitemap.xml`,
    // LLM-friendly docs (no standard robots directive — comment for discovery).
    `# llms.txt: ${origin}/llms.txt`,
    `# llms-full.txt: ${origin}/llms-full.txt`,
    '',
  ].join('\n')
}

function alternates(origin: string, path: string): string {
  const links = locales.map(
    (l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${origin}${localizePath(l, path)}"/>`,
  )
  links.push(
    `<xhtml:link rel="alternate" hreflang="x-default" href="${origin}${localizePath(defaultLocale, path)}"/>`,
  )
  return links.join('')
}

export function buildSitemap(origin: string, singleLocalePaths: string[] = []): string {
  const bilingual = locales.flatMap((l) =>
    PUBLIC_PATHS.map(
      (p) => `<url><loc>${origin}${localizePath(l, p)}</loc>${alternates(origin, p)}</url>`,
    ),
  )
  const single = singleLocalePaths.map((p) => `<url><loc>${origin}${p}</loc></url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${[...bilingual, ...single].join('')}</urlset>`
}

export interface WebManifest {
  short_name: string
  name: string
  icons: { src: string; sizes?: string; type?: string }[]
  start_url: string
  display: string
  theme_color: string
  background_color: string
}

/**
 * Web app manifest 的正文。
 *
 * 由路由 `/manifest.webmanifest` 现算而不是放 `public/manifest.json`：品牌名是
 * build-time 值，静态文件读不到它（详见 `src/lib/brand.ts`）。取 `appName` 而不是直接
 * import `APP_NAME`，是为了让这个模块对 node pool 保持纯粹、测试能断言任意品牌的输出。
 */
export function buildManifest(appName: string, iconVersion = ''): WebManifest {
  // iconVersion 只在需要强行刷新已缓存的图标时传（例如换了 logo）,拼成 `logo192.png?v=2`。
  const v = iconVersion ? `?v=${encodeURIComponent(iconVersion)}` : ''
  return {
    short_name: appName,
    name: `${appName} — Cloudflare-native SaaS starter`,
    icons: [
      { src: `favicon.ico${v}`, sizes: '64x64 32x32 24x24 16x16', type: 'image/x-icon' },
      { src: `logo192.png${v}`, type: 'image/png', sizes: '192x192' },
      { src: `logo512.png${v}`, type: 'image/png', sizes: '512x512' },
    ],
    start_url: '.',
    display: 'standalone',
    theme_color: '#e2531c',
    background_color: '#0a0a0a',
  }
}

export interface HeadLink {
  rel: string
  href: string
  hrefLang?: string  // React/HTML camelCase prop name (renders to the `hreflang` attribute)
}

export interface HeadMeta {
  title?: string
  name?: string
  property?: string
  content?: string
}

export function localeHead(input: {
  origin: string
  locale: Locale
  path: string
  title: string
  description: string
}): { meta: HeadMeta[]; links: HeadLink[] } {
  const { origin, locale, path, title, description } = input
  const canonical = `${origin}${localizePath(locale, path)}`
  const links: HeadLink[] = [{ rel: 'canonical', href: canonical }]
  for (const l of locales) {
    links.push({ rel: 'alternate', hrefLang: l, href: `${origin}${localizePath(l, path)}` })
  }
  links.push({
    rel: 'alternate',
    hrefLang: 'x-default',
    href: `${origin}${localizePath(defaultLocale, path)}`,
  })
  const meta: HeadMeta[] = [
    { title },
    { name: 'description', content: description },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    { property: 'og:url', content: canonical },
    { property: 'og:locale', content: OG_LOCALE[locale] },
    { property: 'og:image', content: `${origin}/logo512.png` },
    { name: 'twitter:card', content: 'summary_large_image' },
  ]
  return { meta, links }
}
