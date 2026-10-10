/** Better-Auth 错误对象 → auth.errors.* i18n key。 */
export function mapAuthError(
  error: { code?: string; message?: string; status?: number } | undefined | null,
): string {
  if (error?.status === 429) return 'auth.errors.rateLimited'
  const map: Record<string, string> = {
    INVALID_EMAIL_OR_PASSWORD: 'auth.errors.invalidCredentials',
    USER_ALREADY_EXISTS: 'auth.errors.emailExists',
    // better-auth answers a duplicate signup with the generic success response
    // only while verification is enforced. With AUTH_EMAIL_VERIFY=false it fails
    // outright under this longer code, which would otherwise show as "unknown".
    USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'auth.errors.emailExists',
    EMAIL_NOT_VERIFIED: 'auth.errors.emailNotVerified',
    INVALID_TOKEN: 'auth.errors.invalidToken',
    PASSWORD_TOO_SHORT: 'auth.errors.weakPassword',
    PASSWORD_TOO_LONG: 'auth.errors.weakPassword',
  }
  const code = error?.code
  if (code && map[code]) return map[code]
  // Turnstile/captcha plugin failures surface as a message, not a mapped code.
  if (/captcha/i.test(error?.message ?? '')) return 'auth.errors.captchaFailed'
  return 'auth.errors.unknown'
}
