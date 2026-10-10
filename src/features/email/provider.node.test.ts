import { test, expect } from 'vitest'
import {
  emailApiKeyFor,
  hasEmailDelivery,
  parseFromHeader,
  resolveEmailProviderId,
} from '@/features/email/provider'

test('不设 EMAIL_PROVIDER 就是 resend —— 老 .dev.vars 不需要任何改动', () => {
  expect(resolveEmailProviderId({})).toBe('resend')
  expect(resolveEmailProviderId({ EMAIL_PROVIDER: '' })).toBe('resend')
  expect(resolveEmailProviderId({ EMAIL_PROVIDER: '   ' })).toBe('resend')
})

test('EMAIL_PROVIDER 大小写/空格不敏感，认得 flowmails', () => {
  expect(resolveEmailProviderId({ EMAIL_PROVIDER: 'flowmails' })).toBe('flowmails')
  expect(resolveEmailProviderId({ EMAIL_PROVIDER: ' FlowMails ' })).toBe('flowmails')
})

test('未知服务商回落 resend（真正的拦截在 env-validate 的硬错误里）', () => {
  expect(resolveEmailProviderId({ EMAIL_PROVIDER: 'flowmail' })).toBe('resend')
  expect(resolveEmailProviderId({ EMAIL_PROVIDER: 'sendgrid' })).toBe('resend')
})

test('只取所选服务商的 key：选了 flowmails 不会回落到已配的 RESEND_API_KEY', () => {
  const env = { RESEND_API_KEY: 're_x', EMAIL_FLOWMAILS_APIKEY: 'fm_x' }
  expect(emailApiKeyFor('resend', env)).toBe('re_x')
  expect(emailApiKeyFor('flowmails', env)).toBe('fm_x')
  // 半配置：切了 flowmails 但没配它的 key —— 宁可降级，也不换个服务商真发。
  expect(emailApiKeyFor('flowmails', { RESEND_API_KEY: 're_x' })).toBeUndefined()
})

test('空白 key 当作没配（wrangler 把未设的 secret 声明成 ""）', () => {
  expect(emailApiKeyFor('resend', { RESEND_API_KEY: '   ' })).toBeUndefined()
  expect(hasEmailDelivery({ RESEND_API_KEY: '' })).toBe(false)
})

test('hasEmailDelivery 跟着所选服务商走', () => {
  expect(hasEmailDelivery({ RESEND_API_KEY: 're_x' })).toBe(true)
  expect(hasEmailDelivery({ EMAIL_PROVIDER: 'flowmails', EMAIL_FLOWMAILS_APIKEY: 'fm_x' })).toBe(true)
  // 只有 resend 的 key 却选了 flowmails → 发不出去
  expect(hasEmailDelivery({ EMAIL_PROVIDER: 'flowmails', RESEND_API_KEY: 're_x' })).toBe(false)
})

test('parseFromHeader 拆出裸地址与显示名（Flowmails 的 from/fromName）', () => {
  expect(parseFromHeader('noreply@example.com')).toEqual({ address: 'noreply@example.com' })
  expect(parseFromHeader('FlareStarter <onboarding@resend.dev>')).toEqual({
    address: 'onboarding@resend.dev',
    name: 'FlareStarter',
  })
  expect(parseFromHeader('"Acme Inc" <hi@acme.dev>')).toEqual({ address: 'hi@acme.dev', name: 'Acme Inc' })
  expect(parseFromHeader('  Support <hi@acme.dev>  ')).toEqual({ address: 'hi@acme.dev', name: 'Support' })
})

test('parseFromHeader 对空/垃圾输入返回 undefined，而不是猜一个地址', () => {
  // Flowmails 会以 422 from_domain_mismatch 拒一个瞎猜的地址；宁可降级到本地捕获。
  expect(parseFromHeader(undefined)).toBeUndefined()
  expect(parseFromHeader('')).toBeUndefined()
  expect(parseFromHeader('   ')).toBeUndefined()
  expect(parseFromHeader('FlareStarter')).toBeUndefined()
  expect(parseFromHeader('<not-an-address>')).toBeUndefined()
})