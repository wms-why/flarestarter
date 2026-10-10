import { test, expect } from 'vitest'
import { mapAuthError } from '@/features/auth/errors'

test('已知错误码映射到 i18n key', () => {
  expect(mapAuthError({ code: 'INVALID_EMAIL_OR_PASSWORD' })).toBe('auth.errors.invalidCredentials')
  expect(mapAuthError({ code: 'USER_ALREADY_EXISTS' })).toBe('auth.errors.emailExists')
  expect(mapAuthError({ code: 'EMAIL_NOT_VERIFIED' })).toBe('auth.errors.emailNotVerified')
})

test('关闭邮箱验证后，重复注册报的长错误码也映射成「邮箱已被注册」', () => {
  // AUTH_EMAIL_VERIFY=false 时 better-auth 不再返回通用成功响应，而是直接抛这个码。
  expect(mapAuthError({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' })).toBe('auth.errors.emailExists')
})

test('未知错误回退到 unknown', () => {
  expect(mapAuthError({ code: 'WHATEVER' })).toBe('auth.errors.unknown')
  expect(mapAuthError(undefined)).toBe('auth.errors.unknown')
  expect(mapAuthError(null)).toBe('auth.errors.unknown')
})
