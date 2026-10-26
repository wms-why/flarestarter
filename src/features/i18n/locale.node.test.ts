import { test, expect } from 'vitest'
import {
  interpolate,
  translate,
  negotiateLocale,
  locales,
  defaultLocale,
  dictionaries,
  stripDefaultLocalePrefix,
} from '@/features/i18n/locale'
import { en } from '@/features/i18n/dictionaries/en'
import { APP_NAME } from '@/lib/brand'

test('stripDefaultLocalePrefix：去掉 /en 前缀且保留 query 和 hash', () => {
  expect(stripDefaultLocalePrefix('/en/pricing?ref=x')).toBe('/pricing?ref=x')
  expect(stripDefaultLocalePrefix('/en/sponsor?status=success&session_id=cs_1')).toBe('/sponsor?status=success&session_id=cs_1')
  expect(stripDefaultLocalePrefix('/en/docs#setup')).toBe('/docs#setup')
  expect(stripDefaultLocalePrefix('/en')).toBe('/')
  expect(stripDefaultLocalePrefix('/en?a=1')).toBe('/?a=1')
  expect(stripDefaultLocalePrefix('/en/')).toBe('/')
})

test('translate 解析嵌套 key', () => {
  expect(translate(en, 'home.title')).toBe('Ship your SaaS on the edge')
})
test('translate 插值 {name}', () => {
  expect(translate(en, 'home.greeting', { name: 'Yang' })).toBe('Hello, Yang!')
})
// interpolate() 是给「不走 i18n 字典、但同样要嵌品牌名」的文案用的（套餐的
// LocalizedText 走的就是它）。它和 translate() 必须共享同一套 `{app}` 语义。
test('interpolate 独立解析 {app}，未知占位符原样保留', () => {
  expect(interpolate('White-label (no {app} branding)')).toBe(`White-label (no ${APP_NAME} branding)`)
  expect(interpolate('hello {who}')).toBe('hello {who}')
  expect(interpolate('{app} and {app}')).toBe(`${APP_NAME} and ${APP_NAME}`)
})
test('translate 缺失 key 回退为 key 本身', () => {
  expect(translate(en, 'home.nope')).toBe('home.nope')
})
// 品牌名走全局插值：几十条文案里的 `{app}` 由 translate() 统一解析，调用点不必
// 记得传参。这两个用例分别锁住「不传参也要替换」和「显式传参仍可覆盖」。
test('translate 不传 params 时 {app} 也会被替换（无提前返回）', () => {
  expect(translate(en, 'common.appName')).toBe(APP_NAME)
  // 正文里的 {app} 同理：中英两个字典都要解析掉
  expect(translate(en, 'app.welcomeSub')).toBe(`Here's your ${APP_NAME} workspace.`)
  expect(translate(dictionaries.zh, 'app.welcomeSub')).toBe(`这是你的 ${APP_NAME} 工作区。`)
})
test('translate 调用点显式传的 app 覆盖全局默认值', () => {
  expect(translate(en, 'common.appName', { app: 'Acme' })).toBe('Acme')
  expect(translate(en, 'home.greeting', { name: 'Yang', app: 'Acme' })).toBe('Hello, Yang!')
})
// 防回归：品牌参数化之后，字典里**任何**一条文案都不该把 `{app}` 原样漏到界面上
// （漏掉一条就会渲染出字面的 `{app}`，而且只有切到那个页面才看得见）。
test('全部字典文案都能解析掉 {app} 与 {name}', () => {
  const walk = (node: unknown, path: string, out: [string, string][]) => {
    if (typeof node === 'string') out.push([path, node])
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, out)
    }
    return out
  }
  for (const locale of locales) {
    for (const [key, raw] of walk(dictionaries[locale], '', [])) {
      const resolved = translate(dictionaries[locale], key)
      expect(resolved, `${locale}:${key}`).not.toContain('{app}')
      // `{name}` 是调用方参数，不在全局表里，原样保留是正确行为——只断言它没被吃掉。
      if (raw.includes('{name}')) expect(resolved, `${locale}:${key}`).toContain('{name}')
    }
  }
})
test('negotiateLocale：cookie 优先', () => {
  expect(negotiateLocale('zh', 'en-US,en')).toBe('zh')
})
test('negotiateLocale：无 cookie 时按 accept-language', () => {
  expect(negotiateLocale(undefined, 'zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh')
})
test('negotiateLocale：都不匹配回退默认', () => {
  expect(negotiateLocale('fr', 'fr-FR')).toBe(defaultLocale)
  expect(locales).toContain(defaultLocale)
})
