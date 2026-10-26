import { describe, expect, test } from 'vitest'
import { APP_GITHUB_URL, APP_NAME, HIDE_URL, normalizeRepoUrl } from '@/lib/brand'

/**
 * 品牌配置在**未配置**时的行为契约。
 *
 * 为什么这些断言看起来像在测常量：vitest 的 node pool 不跑 vite 的 `define`、也不加载
 * `.env`（实测：自定义 `import.meta.env` 键在这里全是 `undefined`），所以这一层真正被测到
 * 的就是**兜底值**——而兜底值必须与改造前的模板行为逐字一致，否则同一份代码在 CI
 * （无 `.env`）和开发者本机（有 `.env`）会跑出不同结果。
 */
describe('brand: 未配置时的兜底', () => {
  test('APP_NAME 回落到模板名，绝不渲染出 undefined', () => {
    expect(APP_NAME).toBe('FlareStarter')
    expect(APP_NAME).not.toBe('undefined')
  })

  test('APP_GITHUB_URL 在测试环境里是空串 —— 所有消费点都必须判空', () => {
    // 这就是为什么 hero / footer / site-nav / cta / pricing / docs 每个渲染处都写成
    // `{GITHUB_URL && <a …/>}`：空串时不能产出 `href=""` 的死链。
    expect(APP_GITHUB_URL).toBe('')
  })
})

/**
 * 「隐藏仓库链接」的哨兵值。
 *
 * `vite.config.ts` 的 `brandValue()` 把空白视为未配置（这是它兜回模板默认值的方式），
 * 所以空串无法表达「故意没有仓库」。`-` 是那个显式的哨兵；`normalizeRepoUrl()` 负责把它
 * 归一成空串，消费点只看「真值 / 假值」。
 */
describe('brand: APP_GITHUB_URL 的隐藏哨兵', () => {
  test('HIDE_URL 归一成空串 → 消费点不渲染任何仓库链接', () => {
    expect(normalizeRepoUrl(HIDE_URL)).toBe('')
    expect(HIDE_URL).toBe('-')
  })

  test('普通 URL 原样保留', () => {
    const url = 'https://github.com/acme/app'
    expect(normalizeRepoUrl(url)).toBe(url)
  })

  test('空串仍是空串（测试 / 未内联环境）', () => {
    expect(normalizeRepoUrl('')).toBe('')
  })

  test('除哨兵外的任何非空值都不会被当成「隐藏」', () => {
    for (const raw of ['https://x.dev', 'none', 'off', '-1', '--']) {
      expect(normalizeRepoUrl(raw), raw).toBe(raw)
    }
  })
})
