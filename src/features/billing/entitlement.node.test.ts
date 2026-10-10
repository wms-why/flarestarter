import { test, expect } from 'vitest'
import { resolveEntitlement, translateStripeEvent, isActivePro, hasProAccess } from '@/features/billing/entitlement'

test('无订阅行 → free', () => {
  expect(resolveEntitlement(null)).toEqual({ plan: 'free', status: 'none', isActive: false, currentPeriodEnd: null, lifetime: false, paymentFailed: false, provider: null })
})
test('active pro → Pro', () => {
  expect(resolveEntitlement({ status: 'active', plan: 'pro', currentPeriodEnd: 123, lifetime: false })).toEqual({ plan: 'pro', status: 'active', isActive: true, currentPeriodEnd: 123, lifetime: false, paymentFailed: false, provider: null })
})
test('past_due → 降回 free 门控', () => {
  const e = resolveEntitlement({ status: 'past_due', plan: 'pro', currentPeriodEnd: 123 })
  expect(e.isActive).toBe(false); expect(e.plan).toBe('free')
})

test('lifetime 行 → 永久 Pro（currentPeriodEnd=null, isActive）', () => {
  expect(resolveEntitlement({ status: 'active', plan: 'pro', currentPeriodEnd: null, lifetime: true })).toEqual({ plan: 'pro', status: 'active', isActive: true, currentPeriodEnd: null, lifetime: true, paymentFailed: false, provider: null })
})
test('lifetime 优先于 status：即使 status=canceled 仍 Pro', () => {
  const e = resolveEntitlement({ status: 'canceled', plan: 'free', currentPeriodEnd: null, lifetime: true })
  expect(e.plan).toBe('pro')
  expect(e.isActive).toBe(true)
  expect(e.lifetime).toBe(true)
})

test('hasProAccess：pro 计划或 admin 角色放行，普通 free 用户不放行', () => {
  const free = resolveEntitlement(null)
  const pro = resolveEntitlement({ status: 'active', plan: 'pro', currentPeriodEnd: 123, lifetime: false })
  expect(hasProAccess('user', pro)).toBe(true)
  expect(hasProAccess('admin', free)).toBe(true) // role 给能力
  expect(hasProAccess('user', free)).toBe(false)
  expect(hasProAccess(null, free)).toBe(false)
  expect(hasProAccess(undefined, free)).toBe(false)
})

test('translateStripeEvent: subscription.updated → upserted（v22 period 在 item 上，携带 occurredAt 供乱序守卫）', () => {
  const ev: any = { id: 'evt_1', type: 'customer.subscription.updated', created: 1_700_000_100, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false, items: { data: [{ current_period_end: 100, price: { id: 'price_1' } }] } } } }
  expect(translateStripeEvent(ev)).toEqual({ type: 'subscription.upserted', eventId: 'evt_1', providerId: 'stripe', userId: null, customerId: 'cus_1', subscriptionId: 'sub_1', status: 'active', plan: null, productId: 'price_1', currentPeriodEnd: 100000, cancelAtPeriodEnd: false, occurredAt: 1_700_000_100_000 })
})
test('translateStripeEvent: subscription.deleted → deleted（携带 occurredAt）', () => {
  const ev: any = { id: 'evt_2', type: 'customer.subscription.deleted', created: 1_700_000_200, data: { object: { id: 'sub_1', customer: 'cus_1' } } }
  expect(translateStripeEvent(ev)).toEqual({ type: 'subscription.deleted', eventId: 'evt_2', providerId: 'stripe', userId: null, customerId: 'cus_1', subscriptionId: 'sub_1', occurredAt: 1_700_000_200_000 })
})
test('translateStripeEvent: 其他 → ignored', () => {
  const ev: any = { id: 'evt_3', type: 'invoice.paid', data: { object: {} } }
  expect(translateStripeEvent(ev)).toEqual({ type: 'ignored', eventId: 'evt_3' })
})

test('trialing pro → isActive true / pro gating', () => {
  const e = resolveEntitlement({ status: 'trialing', plan: 'pro', currentPeriodEnd: 999 })
  expect(e.isActive).toBe(true)
  expect(e.plan).toBe('pro')
})

test('checkout.session.completed → ignored (ensureCustomer already links)', () => {
  const ev: any = { id: 'evt_4', type: 'checkout.session.completed', data: { object: {} } }
  expect(translateStripeEvent(ev)).toEqual({ type: 'ignored', eventId: 'evt_4' })
})

test('translateStripeEvent: checkout.session.completed (payment, paid) → purchase.completed（携带 PI 供退款精确匹配）', () => {
  const ev: any = { id: 'evt_p1', type: 'checkout.session.completed', data: { object: { mode: 'payment', payment_status: 'paid', customer: 'cus_9', client_reference_id: 'u1', payment_intent: 'pi_life_1' } } }
  expect(translateStripeEvent(ev)).toEqual({ type: 'purchase.completed', eventId: 'evt_p1', providerId: 'stripe', userId: 'u1', customerId: 'cus_9', plan: null, productId: null, paymentRef: 'pi_life_1' })
})
test('translateStripeEvent: completed 但 payment_status=unpaid（ACH/SEPA 延迟到账）→ ignored，不预授终身 Pro', () => {
  const ev: any = { id: 'evt_p2', type: 'checkout.session.completed', data: { object: { mode: 'payment', payment_status: 'unpaid', customer: 'cus_9', payment_intent: 'pi_life_2' } } }
  expect(translateStripeEvent(ev)).toEqual({ type: 'ignored', eventId: 'evt_p2' })
})
test('translateStripeEvent: async_payment_succeeded（到账重放）→ purchase.completed', () => {
  const ev: any = { id: 'evt_p3', type: 'checkout.session.async_payment_succeeded', data: { object: { mode: 'payment', payment_status: 'paid', customer: 'cus_9', payment_intent: 'pi_life_3' } } }
  expect(translateStripeEvent(ev)).toEqual({ type: 'purchase.completed', eventId: 'evt_p3', providerId: 'stripe', userId: null, customerId: 'cus_9', plan: null, productId: null, paymentRef: 'pi_life_3' })
})
test('translateStripeEvent: charge.refunded (全额) → purchase.refunded（携带被退款 charge 的 PI）', () => {
  const ev: any = { id: 'evt_r1', type: 'charge.refunded', data: { object: { customer: 'cus_9', amount: 19900, amount_refunded: 19900, refunded: true, payment_intent: 'pi_life_1' } } }
  expect(translateStripeEvent(ev)).toEqual({ type: 'purchase.refunded', eventId: 'evt_r1', providerId: 'stripe', userId: null, customerId: 'cus_9', paymentRef: 'pi_life_1' })
})
test('translateStripeEvent: invoice.payment_failed → payment.failed（携带 occurredAt）', () => {
  const ev: any = { id: 'evt_pf1', type: 'invoice.payment_failed', created: 1_700_000_300, data: { object: { customer: 'cus_9' } } }
  expect(translateStripeEvent(ev)).toEqual({ type: 'payment.failed', eventId: 'evt_pf1', providerId: 'stripe', userId: null, customerId: 'cus_9', occurredAt: 1_700_000_300_000 })
})

test('paymentFailed: paymentFailedAt 非空 → true', () => {
  expect(resolveEntitlement({ status: 'past_due', plan: 'pro', currentPeriodEnd: 123, paymentFailedAt: 1000 }).paymentFailed).toBe(true)
})
test('paymentFailed: paymentFailedAt 空 → false', () => {
  expect(resolveEntitlement({ status: 'active', plan: 'pro', currentPeriodEnd: 123 }).paymentFailed).toBe(false)
})
test('paymentFailed: lifetime 用户无续费概念 → 始终 false', () => {
  expect(resolveEntitlement({ status: 'active', plan: 'pro', currentPeriodEnd: null, lifetime: true, paymentFailedAt: 1000 }).paymentFailed).toBe(false)
})
test('paymentFailed: 无订阅行 → false', () => {
  expect(resolveEntitlement(null).paymentFailed).toBe(false)
})

test('isActivePro: lifetime row → true even if status canceled', () => {
  expect(isActivePro({ status: 'canceled', plan: 'free', lifetime: true })).toBe(true)
})
test('isActivePro: active pro → true', () => {
  expect(isActivePro({ status: 'active', plan: 'pro' })).toBe(true)
})
test('isActivePro: trialing pro → true', () => {
  expect(isActivePro({ status: 'trialing', plan: 'pro' })).toBe(true)
})
test('isActivePro: past_due pro → false', () => {
  expect(isActivePro({ status: 'past_due', plan: 'pro' })).toBe(false)
})
test('isActivePro: active free → false', () => {
  expect(isActivePro({ status: 'active', plan: 'free' })).toBe(false)
})

test('enterprise 行 → enterprise 门控（≥ pro）', () => {
  const e = resolveEntitlement({ status: 'active', plan: 'enterprise', currentPeriodEnd: 123 })
  expect(e.plan).toBe('enterprise')
  expect(e.isActive).toBe(true)
  expect(hasProAccess('user', e)).toBe(true)
})

test('resolveEntitlement: 未知 plan 值降级为 free 而不是放行', () => {
  const e = resolveEntitlement({ status: 'active', plan: 'platinum', currentPeriodEnd: 1 })
  expect(e.plan).toBe('free')
  expect(e.isActive).toBe(true)
})

test('resolveEntitlement: provider 随行透传（决定门户 vs 应用内取消）', () => {
  expect(resolveEntitlement({ status: 'active', plan: 'pro', currentPeriodEnd: 1, provider: 'paypal' }).provider).toBe('paypal')
  expect(resolveEntitlement({ status: 'active', plan: 'pro', currentPeriodEnd: 1 }).provider).toBeNull()
})

test('isActivePro: active enterprise → true（订单高于 pro）', () => {
  expect(isActivePro({ status: 'active', plan: 'enterprise' })).toBe(true)
})

// ── canceling ──────────────────────────────────────────────────────────────
// `canceling` means "cancellation requested, access runs to the end of the
// period already paid for". Treating it as inactive would strip a paying
// customer's access the instant they clicked cancel.
test('canceling keeps paid access (at-period-end vendors)', () => {
  const e = resolveEntitlement({ status: 'canceling', plan: 'pro', currentPeriodEnd: 123 })
  expect(e.plan).toBe('pro')
  expect(e.isActive).toBe(true)
  expect(e.status).toBe('canceling')
})

test('canceling enterprise keeps access too', () => {
  expect(resolveEntitlement({ status: 'canceling', plan: 'enterprise', currentPeriodEnd: 1 }).plan).toBe('enterprise')
})

test('isActivePro: canceling pro → true', () => {
  expect(isActivePro({ status: 'canceling', plan: 'pro' })).toBe(true)
})

test('canceled is NOT access — that is the terminal state', () => {
  const e = resolveEntitlement({ status: 'canceled', plan: 'pro', currentPeriodEnd: 123 })
  expect(e.plan).toBe('free')
  expect(e.isActive).toBe(false)
  expect(isActivePro({ status: 'canceled', plan: 'pro' })).toBe(false)
})
