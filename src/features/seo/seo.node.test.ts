import { test, expect } from 'vitest'
import { buildManifest, buildRobots, buildSitemap, localeHead } from '@/features/seo/seo'
import { resolveSiteOrigin } from '@/features/seo/seo.fns'
import { localizePath } from '@/features/i18n/locale'

const origin = 'https://app.example.com'

test('localizePath: en no prefix, zh prefixed', () => {
  expect(localizePath('en', '/')).toBe('/')
  expect(localizePath('zh', '/')).toBe('/zh')
  expect(localizePath('en', '/pricing')).toBe('/pricing')
  expect(localizePath('zh', '/pricing')).toBe('/zh/pricing')
})

test('robots disallows app/admin/api + lists sitemap', () => {
  const r = buildRobots(origin)
  expect(r).toContain('Disallow: /*/app')
  expect(r).toContain('Disallow: /app')
  expect(r).toContain('Disallow: /*/admin')
  expect(r).toContain('Disallow: /api')
  expect(r).toContain(`Sitemap: ${origin}/sitemap.xml`)
})

test('sitemap lists both locales of public pages with hreflang', () => {
  const xml = buildSitemap(origin)
  expect(xml).toContain('<urlset')
  expect(xml).toContain(`<loc>${origin}/</loc>`)
  expect(xml).toContain(`<loc>${origin}/zh</loc>`)
  expect(xml).toContain(`<loc>${origin}/pricing</loc>`)
  expect(xml).toContain(`<loc>${origin}/zh/pricing</loc>`)
  expect(xml).toContain(`<loc>${origin}/waitlist</loc>`)
  expect(xml).toContain(`<loc>${origin}/zh/waitlist</loc>`)
  expect(xml).toContain('hreflang="en"')
  expect(xml).toContain('hreflang="zh"')
  expect(xml).toContain('hreflang="x-default"')
  expect(xml).toContain(`<loc>${origin}/changelog</loc>`)
  expect(xml).toContain(`<loc>${origin}/zh/changelog</loc>`)
  expect(xml).toContain(`<loc>${origin}/sponsor</loc>`)
  expect(xml).toContain(`<loc>${origin}/zh/sponsor</loc>`)
})

test('sitemap includes single-locale docs paths without hreflang alternates', () => {
  const xml = buildSitemap(origin, ['/docs', '/docs/install'])
  // exact <url> block match — alternates would sit between </loc> and </url>
  expect(xml).toContain(`<url><loc>${origin}/docs</loc></url>`)
  expect(xml).toContain(`<url><loc>${origin}/docs/install</loc></url>`)
  // no zh-prefixed docs URL, and no alternate hreflang for docs
  expect(xml).not.toContain(`${origin}/zh/docs`)
})

test('localeHead: canonical + hreflang alternates + og', () => {
  const head = localeHead({ origin, locale: 'zh', path: '/pricing', title: 'T', description: 'D' })
  expect(head.links.find((l) => l.rel === 'canonical')?.href).toBe(`${origin}/zh/pricing`)
  expect(head.links.some((l) => l.rel === 'alternate' && l.hrefLang === 'en' && l.href === `${origin}/pricing`)).toBe(true)
  expect(head.links.some((l) => l.rel === 'alternate' && l.hrefLang === 'zh' && l.href === `${origin}/zh/pricing`)).toBe(true)
  expect(head.links.some((l) => l.hrefLang === 'x-default')).toBe(true)
  expect(head.meta.some((m) => m.title === 'T')).toBe(true)
  expect(head.meta.some((m) => m.property === 'og:url' && m.content === `${origin}/zh/pricing`)).toBe(true)
})

// 品牌换域名后，canonical 该跟着 APP_URL 走；但改造前只有 BETTER_AUTH_URL 的部署
// 不能因为引入了新变量就悄悄改掉 canonical。这条把两种情况的边界钉死。
test('resolveSiteOrigin: 配了 APP_URL 就用它，没配则回落 BETTER_AUTH_URL', () => {
  const auth = 'http://localhost:3000'

  // 配了真实品牌域名 → 用它
  expect(resolveSiteOrigin('https://finalimg.com', auth)).toBe('https://finalimg.com')
  // 模板兜底值（*.example.com）视为「没配」→ 回落认证 origin
  expect(resolveSiteOrigin('https://flarestarter.example.com', auth)).toBe('http://localhost:3000')
  // 下游把自己的默认域名也设成 *.example.com 时同样回落
  expect(resolveSiteOrigin('https://app.example.com', auth)).toBe('http://localhost:3000')
  // 空串 / 非法 URL 不能让 head() 挂掉
  expect(resolveSiteOrigin('', auth)).toBe('http://localhost:3000')
  expect(resolveSiteOrigin('not a url', auth)).toBe('http://localhost:3000')
  // 带上 path 的配置值只取 origin
  expect(resolveSiteOrigin('https://finalimg.com/some/path', auth)).toBe('https://finalimg.com')
})

// manifest 换成动态路由产出之后，名称必须跟着品牌走——否则白牌站会露出模板名。
test('buildManifest 的 name/short_name 跟随品牌名', () => {
  const m = buildManifest('TestApp')
  expect(m.short_name).toBe('TestApp')
  expect(m.name).toContain('TestApp')
  expect(m.name).not.toContain('FlareStarter')
  // 图标与显示设置仍是模板的那一套
  expect(m.icons.map((i) => i.src)).toEqual(['favicon.ico', 'logo192.png', 'logo512.png'])
  expect(m.display).toBe('standalone')
  expect(m.start_url).toBe('.')
})
