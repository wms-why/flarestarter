import { test, expect, vi } from 'vitest'
import { sendEmailWith, resendTransport, flowmailsTransport, createTransport } from '@/features/email/email.server'
import { createDevTransport } from '@/features/email/dev-transport'
import { DEFAULT_RESEND_FROM } from '@/features/email/provider'

// vi.hoisted: the mock factories run when `email.server` first imports these
// packages, which is before the file's own `const`s are initialized.
const { resendSend, flowmailsSend } = vi.hoisted(() => ({
  resendSend: vi.fn(async () => ({ data: null, error: { name: 'validation_error', message: 'domain is not verified' } })),
  flowmailsSend: vi.fn(async () => ({ id: 'msg_1', status: 'queued' })),
}))

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend }
  },
}))

vi.mock('@flowmails/flowmails-sdk', () => ({
  Flowmails: class {
    send = flowmailsSend
  },
}))

const sample = { to: 'u@x.com', subject: 's', html: '<p>s</p>', text: 's' }

test('resendTransport 把 Resend API 错误抛出（SDK 自己不抛，静默吞掉=验证邮件丢失无日志）', async () => {
  const t = resendTransport('re_key', 'X <x@example.com>')
  await expect(t.send(sample)).rejects.toThrow('domain is not verified')
})

test('sendEmailWith 经 transport 发送渲染后的邮件', async () => {
  const t = createDevTransport()
  await sendEmailWith(t, { to: 'u@x.com', locale: 'en', template: 'verify-email', data: { url: 'https://app/v?t=1' } })
  expect(t.captured).toHaveLength(1)
  expect(t.captured[0].subject).toBe('Verify your email')
  expect(t.captured[0].html).toContain('https://app/v?t=1')
})

test('flowmailsTransport 把 from 拆成裸地址 + fromName（Flowmails 后端只认裸地址）', async () => {
  flowmailsSend.mockClear()
  const t = await flowmailsTransport('fm_key', { address: 'hi@acme.dev', name: 'Acme' })
  await t.send(sample)
  expect(flowmailsSend).toHaveBeenCalledWith({
    from: 'hi@acme.dev',
    fromName: 'Acme',
    to: 'u@x.com',
    subject: 's',
    text: 's',
    html: '<p>s</p>',
  })
})

test('flowmailsTransport 透传 SDK 的类型化错误 —— 不包成普通 Error，否则 instanceof 判断就废了', async () => {
  flowmailsSend.mockRejectedValueOnce(new Error('Validation failed: from_domain_mismatch'))
  const t = await flowmailsTransport('fm_key', { address: 'hi@acme.dev' })
  await expect(t.send(sample)).rejects.toThrow('from_domain_mismatch')
})

test('createTransport：resend 缺 EMAIL_FROM 用公共测试发件人', async () => {
  resendSend.mockClear()
  const t = await createTransport('resend', 're_key', '   ')
  // The mocked Resend always errors; what matters is the from it was handed.
  await expect(t.send(sample)).rejects.toThrow()
  expect(resendSend).toHaveBeenCalledWith(expect.objectContaining({ from: DEFAULT_RESEND_FROM }))
})

test('createTransport：flowmails 缺一个合法 EMAIL_FROM 就降级到 dev transport，绝不猜地址真发', async () => {
  flowmailsSend.mockClear()
  const t = await createTransport('flowmails', 'fm_key', 'not-an-address')
  await t.send(sample)
  expect(flowmailsSend).not.toHaveBeenCalled()
})