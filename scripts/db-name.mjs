/**
 * `db:*` 脚本的库名解析器。
 *
 * 为什么不让脚本里直接写库名：下游 fork 后会把 `flarestarter-db*` 换成本产品的
 * 名字，如果库名散落在 5 条 npm script 里（还要拼 `-staging` / `-prod` 后缀），
 * 每次同步上游都会冲突，而且改漏一条就会默默迁移错库。
 *
 * 为什么不用 `npm_package_config_db_name` 插值：npm 的 script 变量在 Windows 上
 * 行为不稳，而且目标库名还取决于 `--env`（本地 / staging / production 是三个不同的
 * D1 库）。所以改为从 `wrangler.jsonc` 读**实际**配置的库名——那才是唯一真源。
 *
 * 用法（被 package.json 的 db:* 脚本调用）：
 *   node scripts/db-name.mjs                       → 本地库名（顶层 d1_databases）
 *   node scripts/db-name.mjs --env staging         → env.staging 的库名
 *   node scripts/db-name.mjs --env production      → env.production 的库名
 *
 * 回退顺序：wrangler.jsonc → package.json 的 `config.dbName` → `flarestarter-db`。
 * 找不到时静默回落，绝不抛错——`db:*` 脚本要能挂在尚未 `cp wrangler.example.jsonc
 * wrangler.jsonc` 的仓库上跑。
 */
import { existsSync, readFileSync } from 'node:fs'

const DEFAULT_DB_NAME = 'flarestarter-db'

/**
 * 取出某个顶层键后面那个 `{ ... }` 块的文本（含嵌套）。
 *
 * 用一个花括号深度扫描，而不是正则：env 块里嵌着 d1_databases / r2_buckets 数组，
 * 正则匹配不到配对的右括号，早期版本因此把 staging 误读成了 production 的库名。
 */
function objectBlockAfter(text, startAt) {
  const open = text.indexOf('{', startAt)
  if (open === -1) return undefined
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return undefined
}

/** 该片段里 `database_name` 的值（一个 env 块内只有一个 DB binding，取第一个即可）。 */
function databaseNameIn(text) {
  return text.match(/"database_name"\s*:\s*"([^"]+)"/)?.[1]
}

/**
 * 读出指定环境的 D1 库名。不传 `env` 时读顶层配置（本地开发用的那个库）。
 *
 * 不引入 JSON5 解析器：`wrangler.jsonc` 带注释和尾逗号，标准 `JSON.parse` 会拒；
 * 而 `wrangler` 自己的解析器要连带拉起整个 CLI。花括号扫描已经足够精确。
 */
export function resolveDbName({
  env,
  wranglerPath = 'wrangler.jsonc',
  packagePath = 'package.json',
} = {}) {
  if (existsSync(wranglerPath)) {
    const raw = readFileSync(wranglerPath, 'utf8')
    if (env) {
      // 定位 `env` 对象，再在它里面定位 `"<env>": {`
      const envRootAt = raw.search(/"env"\s*:\s*\{/)
      const envRoot = envRootAt === -1 ? undefined : objectBlockAfter(raw, envRootAt)
      if (envRoot) {
        const at = envRoot.search(new RegExp(`"${env}"\\s*:\\s*\\{`))
        const block = at === -1 ? undefined : objectBlockAfter(envRoot, at)
        const name = block && databaseNameIn(block)
        if (name) return name
      }
    } else {
      // 顶层：`"env": {` 之前的部分就是顶层配置
      const envRootAt = raw.search(/"env"\s*:\s*\{/)
      const topLevel = envRootAt === -1 ? raw : raw.slice(0, envRootAt)
      const name = databaseNameIn(topLevel)
      if (name) return name
    }
  }

  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (pkg?.config?.dbName) return pkg.config.dbName
    } catch {
      // package.json 读不动就继续回退，不该让 db:* 挂掉
    }
  }

  return DEFAULT_DB_NAME
}

// 作为脚本被调用时才打印（被单测 import 时不输出）
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const envAt = process.argv.indexOf('--env')
  const env = envAt === -1 ? undefined : process.argv[envAt + 1]
  process.stdout.write(resolveDbName({ env }))
}

export { DEFAULT_DB_NAME }
