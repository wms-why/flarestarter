/**
 * 品牌配置 —— build-time 取值。
 *
 * 与 `lib/analytics.ts` 同一个范式：值由 Vite **构建时内联**成字面量
 * （见 `vite.config.ts` 的 `define`），所以既能在浏览器组件里读，也能在
 * Worker/SSR 里读，且不经过 `@/lib/env`（那会拉进 `cloudflare:workers`，
 * 在浏览器里直接炸）。
 *
 * 为什么不用 Worker 变量：品牌名会出现在 `index.html` 的 title 和打包后的
 * 组件里，必须在构建时就定下来。读 shell/CI 环境变量或 `.env` 文件——
 * **不要**放进 `.dev.vars`。
 *
 * 下游产品改品牌只需改这 4 个环境变量，不必碰任何组件。
 *
 * 关于兜底用 `||` 而不是 `??`：`define` 会把未配置的值内联成 `''`（而不是
 * 删掉这个键），所以这里既要兜 `undefined`（vitest 的 node pool 不走 vite 的
 * `define`，实测这类自定义键在那里全部是 `undefined`），也要兜空串（构建时
 * 只配了 `APP_NAME=` 这种半配置）。
 */

/** 产品名：UI 标题、SEO、邮件发件人显示名、PayPal `brand_name`、结构化数据。 */
export const APP_NAME: string = import.meta.env.APP_NAME || 'FlareStarter'

/** 站点根 URL（SEO canonical / 结构化数据 / 邮件链接）。 */
export const APP_URL: string = import.meta.env.APP_URL || 'https://flarestarter.example.com'

/**
 * 仓库链接（页头/页脚/docs 图标）的原始配置值。
 *
 * 构建期默认指向模板自己的仓库——不配也要能用。
 */
const GITHUB_URL_RAW: string = import.meta.env.APP_GITHUB_URL || ''

/** 表示「本站不展示仓库链接」的哨兵值（见 `APP_GITHUB_URL` 的说明）。 */
export const HIDE_URL = '-'

/**
 * 把 `APP_GITHUB_URL` 的原始配置归一成「可渲染的 URL 或空串」。
 *
 * 独立导出是为了让测试打的是**真实实现**而不是复刻一份逻辑。
 */
export function normalizeRepoUrl(raw: string): string {
  return raw === HIDE_URL ? '' : raw
}

/**
 * 仓库链接；`''` 表示「本站不展示仓库链接」。
 *
 * 怎么表达「隐藏」：把 `APP_GITHUB_URL` 设成 `-`（或任何 `none` / `off` 之类）。
 * 为什么不用空串——`vite.config.ts` 的 `read()` 把空白当**未配置**（那正是它
 * 兜回模板默认值的方式），所以空串无法表达「故意没有仓库」；而 `define` 一定会
 * 内联出一个字符串字面量，`-` 是唯一既非空、又明确不是 URL 的写法。
 *
 * **所有消费点都必须判空**（`{GITHUB_URL && <a …/>}`）：否则隐藏配置或空串会
 * 渲染出一个 `href=""` 的死链（点击等于回到当前页）。
 */
export const APP_GITHUB_URL: string = normalizeRepoUrl(GITHUB_URL_RAW)

/** 法务页、版权行用的法定主体名；未配置时跟随 `APP_NAME`。 */
export const APP_LEGAL_NAME: string = import.meta.env.APP_LEGAL_NAME || APP_NAME
