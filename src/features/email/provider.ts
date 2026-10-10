/**
 * 邮件服务商开关：`EMAIL_PROVIDER` 决定 `sendEmail` 走哪条通道。
 *
 * 设计约束（与 AGENTS.md 的「缺 key → 功能关闭」一致）：
 *
 *   - **默认不变。** 不设 `EMAIL_PROVIDER` 就是 `resend`，一份没升级过的
 *     `.dev.vars` 行为与今天完全一致，不需要任何迁移。
 *   - **选择器与密钥是两条独立的信号。** 选了 `flowmails` 却只配了
 *     `RESEND_API_KEY`，不会「回落到 Resend 真发」——那会把验证邮件发到
 *     另一个服务商手里。密钥按**所选服务商**取，取不到就降级到 dev
 *     transport（只打日志，不误发），并在 env-validate 里告警。
 *   - **未知值回落 resend，而不是抛错。** 拼错（`flowmail`）在这里回落，
 *     但 env-validate 会把它当**硬错误**在启动时拦下（见 env-validate.ts）：
 *     回落方向是「不发」，代价可控；硬失败留在一处即可。
 *
 * 纯函数、无 `cloudflare:workers` 依赖，所以 `email-verification.ts` 与
 * `env-validate.ts` 都能直接复用同一套判定，不会各自再实现一遍。
 */

/** 支持的服务商 id。`EMAIL_PROVIDER` 只认这些值（大小写不敏感）。 */
export const EMAIL_PROVIDERS = ['resend', 'flowmails'] as const

export type EmailProviderId = (typeof EMAIL_PROVIDERS)[number]

/** 未设置 `EMAIL_PROVIDER` 时的默认服务商——保持 Resend 向后兼容。 */
export const DEFAULT_EMAIL_PROVIDER: EmailProviderId = 'resend'

/** 每个服务商的 API Key 环境变量名。告警文案与文档共用这份清单，避免各写各的。 */
export const EMAIL_API_KEY_VAR: Record<EmailProviderId, string> = {
  resend: 'RESEND_API_KEY',
  flowmails: 'EMAIL_FLOWMAILS_APIKEY',
}

export interface EmailEnv {
  /** 服务商开关：留空 = `resend`。 */
  EMAIL_PROVIDER?: string
  RESEND_API_KEY?: string
  EMAIL_FLOWMAILS_APIKEY?: string
  EMAIL_FROM?: string
}

/** 发件人：地址 + 可选显示名。Flowmails 要求 `from` 是纯地址，显示名走 `fromName`。 */
export interface MailboxAddress {
  address: string
  name?: string
}

/** Resend 缺省发件人；Flowmails 没有这种「随便用我测试地址」的余地，故不给缺省。 */
export const DEFAULT_RESEND_FROM = 'FlareStarter <onboarding@resend.dev>'

/** 解析 `EMAIL_PROVIDER`。空白/未知 → resend（见文件头「未知值回落」）。 */
export function resolveEmailProviderId(e: EmailEnv): EmailProviderId {
  const raw = e.EMAIL_PROVIDER?.trim().toLowerCase()
  return (EMAIL_PROVIDERS as readonly string[]).includes(raw ?? '') ? (raw as EmailProviderId) : DEFAULT_EMAIL_PROVIDER
}

/** 取**所选服务商**的 key；没配就返回 undefined（→ 降级 dev transport）。 */
export function emailApiKeyFor(provider: EmailProviderId, e: EmailEnv): string | undefined {
  const key = provider === 'flowmails' ? e.EMAIL_FLOWMAILS_APIKEY : e.RESEND_API_KEY
  return key?.trim() || undefined
}

/** 「这封信真的发得出去吗」——注册强验证（features/auth/email-verification.ts）用的就是它。 */
export function hasEmailDelivery(e: EmailEnv): boolean {
  return Boolean(emailApiKeyFor(resolveEmailProviderId(e), e))
}

/**
 * 拆 `EMAIL_FROM`，两种写法都吃：
 *
 *   `noreply@example.com`            → { address: 'noreply@example.com' }
 *   `FlareStarter <noreply@x.dev>`   → { address: 'noreply@x.dev', name: 'FlareStarter' }
 *
 * 为什么要拆：Resend 的 `from` 收整个 RFC 5322 串（`Name <addr>`），
 * 而 Flowmails 的 `from` **必须是裸地址**（后端正则校验），显示名单走
 * `fromName`。同一个 `EMAIL_FROM` 要喂两个服务商，只能在边界上拆一次。
 *
 * 空白 / 只有尖括号垃圾 → undefined（调用方据此降级，不猜地址）。
 */
export function parseFromHeader(raw: string | undefined): MailboxAddress | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  const angled = value.match(/^(.*?)<([^<>]*)>\s*$/s)
  if (!angled) return value.includes('@') ? { address: value } : undefined
  const address = angled[2].trim()
  if (!address.includes('@')) return undefined
  // 显示名去掉可能存在的引号：`"FlareStarter" <a@b>` → `FlareStarter`
  const name = angled[1].trim().replace(/^"(.*)"$/s, '$1').trim()
  return name ? { address, name } : { address }
}