import { Resend } from 'resend'
import { renderEmail } from './templates'
import { createDevTransport, type SentEmail } from './dev-transport'
import {
  DEFAULT_RESEND_FROM,
  EMAIL_API_KEY_VAR,
  emailApiKeyFor,
  parseFromHeader,
  resolveEmailProviderId,
  type EmailEnv,
  type EmailProviderId,
  type MailboxAddress,
} from './provider'
import type { Locale } from '@/features/i18n/locale'

export interface SendEmailInput {
  to: string
  locale: Locale
  template: 'verify-email' | 'reset-password' | 'pro-activated'
  data: { url: string }
}

interface Transport {
  send(email: SentEmail): Promise<void>
}

/** 可注入 transport 的内部实现（便于测试）。 */
export async function sendEmailWith(transport: Transport, input: SendEmailInput): Promise<void> {
  const rendered = await renderEmail(input)
  await transport.send({ to: input.to, subject: rendered.subject, html: rendered.html, text: rendered.text })
}

/** Exported for tests. Resend's SDK reports API failures via `{ error }` instead of
 *  throwing — without this check a bad EMAIL_FROM or a rate-limit silently drops
 *  verify/reset emails while better-auth believes they were sent. */
export function resendTransport(apiKey: string, from: string): Transport {
  const resend = new Resend(apiKey)
  return {
    async send(email) {
      const { error } = await resend.emails.send({ from, to: email.to, subject: email.subject, html: email.html, text: email.text })
      if (error) throw new Error(`Resend send failed: ${error.name}: ${error.message}`)
    },
  }
}

/**
 * Flowmails 通道（`@flowmails/flowmails-sdk` v0.1）。
 *
 * 与 Resend 那条的关键差别有三点：
 *
 *   1. **SDK 自己抛错**（`AuthenticationError` / `ValidationError` / `RateLimitError`
 *      / `UpstreamError`，都继承 `FlowmailsError`），所以这里**不包**成普通
 *      `Error`——包一层会把 `instanceof` 判断废掉，调用方就没法区分「key 被吊销」
 *      和「上游 5xx，可以重试」了。重试/退避也由 SDK 负责（默认 2 次），不要在外面
 *      再套一层重试循环：`send` 不幂等，重复调用会多发一封。
 *   2. `from` 必须是裸地址且落在 key 绑定的域名上，否则后端 422
 *      `from_domain_mismatch`——显示名只能走 `fromName`，见 `parseFromHeader`。
 *   3. 动态 import：只有真的选了 flowmails，才把这个 SDK 拉进 worker 的模块图。
 *
 * Exported for tests.
 */
export async function flowmailsTransport(apiKey: string, from: MailboxAddress): Promise<Transport> {
  const { Flowmails } = await import('@flowmails/flowmails-sdk')
  const client = new Flowmails({ apiKey })
  return {
    async send(email) {
      await client.send({
        from: from.address,
        fromName: from.name,
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      })
    },
  }
}

/**
 * 按 `EMAIL_PROVIDER` 造 transport；缺配置时回落 dev transport（只打日志，绝不误发）。
 *
 * flowmails 额外要求 `EMAIL_FROM`：它的 key 绑定到某个域名，没有 Resend 那种
 * 公共测试发件人可以兜底。缺地址就没法构造合法 payload——同样降级到 dev
 * transport，并在控制台喊一声，让部署的人看见，而不是让 better-auth 静默吞掉。
 */
export async function createTransport(provider: EmailProviderId, apiKey: string, emailFrom: string | undefined): Promise<Transport> {
  if (provider === 'flowmails') {
    const from = parseFromHeader(emailFrom)
    if (!from) return devTransport(`EMAIL_PROVIDER=flowmails but EMAIL_FROM is unset or not an address (e.g. "Support <hi@yourdomain.com>")`)
    return flowmailsTransport(apiKey, from)
  }
  return resendTransport(apiKey, emailFrom?.trim() || DEFAULT_RESEND_FROM)
}

/** 生产构建里降级路径要脱敏（import.meta.env.PROD 由 vite 构建期注入；vite dev 为 false，
 *  本地开发照旧在控制台拿到完整链接）。 */
function devTransport(reason: string): Transport {
  return createDevTransport({ redactBody: import.meta.env.PROD, reason })
}

/** 生产入口：按 `EMAIL_PROVIDER` 选服务商；对应 key 缺失则降级到控制台捕获（本地不误发）。 */
export async function sendEmail(input: SendEmailInput): Promise<void> {
  // Dynamic import keeps cloudflare:workers out of the module graph in node/test environments.
  const { env } = await import('@/lib/env')
  const provider = resolveEmailProviderId(env as EmailEnv)
  const apiKey = emailApiKeyFor(provider, env as EmailEnv)
  const transport: Transport = apiKey
    ? await createTransport(provider, apiKey, env.EMAIL_FROM)
    : createDevTransport({
        redactBody: import.meta.env.PROD,
        reason: `${EMAIL_API_KEY_VAR[provider]} missing — provider "${provider}" cannot send`,
      })
  await sendEmailWith(transport, input)
}