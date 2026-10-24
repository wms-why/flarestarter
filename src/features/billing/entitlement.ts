import type Stripe from 'stripe'
import { asPlan, isAtLeastTier, tierForProduct, type Plan } from './plans'
import { classifyPurchase } from '@/features/credits/credits.core'
import type { ProviderId } from './providers/catalog'

export type { Plan }
export interface Entitlement {
  plan: Plan
  status: string
  isActive: boolean
  currentPeriodEnd: number | null
  lifetime: boolean
  paymentFailed: boolean
  /** Which vendor owns this subscription — decides portal vs in-app cancel. */
  provider: ProviderId | null
}

// occurredAt（vendor event 的创建时间，epoch ms）：订阅流事件参与乱序守卫——provider 不保证
// 投递顺序，apply 时丢弃比行上 lastEventAt 更旧的事件。购买类事件是绝对事实，不参与此序。
//
// userId vs customerId：只有 Stripe 有我们能预创建的 customer。Waffo / Creem / PayPal 的
// webhook 回带下单时写进 metadata 的 userId，所以定位订单优先按 userId，其次按 customerId。
// 两者皆无 = 无法归属的事件，apply 直接忽略。
export type DomainEvent =
  | { type: 'subscription.upserted'; eventId: string; providerId: ProviderId; userId: string | null; customerId: string | null; subscriptionId: string; status: string; plan: Plan | null; productId: string | null; currentPeriodEnd: number | null; cancelAtPeriodEnd: boolean; occurredAt?: number }
  | { type: 'subscription.deleted'; eventId: string; providerId: ProviderId; userId: string | null; customerId: string | null; subscriptionId: string; occurredAt?: number }
  | { type: 'purchase.completed'; eventId: string; providerId: ProviderId; userId: string | null; customerId: string | null; plan: Plan | null; productId: string | null; paymentRef: string | null }
  | { type: 'credits.purchased'; eventId: string; providerId: ProviderId; userId: string | null; packId: string | null; paymentRef: string | null }
  | { type: 'purchase.refunded'; eventId: string; providerId: ProviderId; userId: string | null; customerId: string | null; paymentRef: string | null }
  | { type: 'payment.failed'; eventId: string; providerId: ProviderId; userId: string | null; customerId: string | null; occurredAt?: number }
  | { type: 'ignored'; eventId: string }

export function resolveEntitlement(row: { status: string; plan: string; currentPeriodEnd: number | null; lifetime?: boolean; paymentFailedAt?: number | null; provider?: string } | null): Entitlement {
  const provider = (typeof row?.provider === 'string' ? row.provider : null) as ProviderId | null
  if (!row) return { plan: 'free', status: 'none', isActive: false, currentPeriodEnd: null, lifetime: false, paymentFailed: false, provider }
  // 终身买断无续费扣款概念，永不显示"扣款失败"。
  if (row.lifetime) return { plan: 'pro', status: 'active', isActive: true, currentPeriodEnd: null, lifetime: true, paymentFailed: false, provider }
  // `canceling` 仍然算有效:期末生效型厂商(Creem 的 scheduled_cancel、Stripe 的
  // cancel_at_period_end)表示「已付费周期结束前仍然可用」。把它排除在有效状态外,
  // 会让一个刚点了取消的用户在周期结束前立刻失去已付费的权益。
  const isActive = ENTITLING_STATUSES.has(row.status)
  const known = asPlan(row.plan)
  const plan: Plan = isActive && known && isAtLeastTier(known, 'pro') ? known : 'free'
  return { plan, status: row.status, isActive, currentPeriodEnd: row.currentPeriodEnd, lifetime: false, paymentFailed: row.paymentFailedAt != null, provider }
}

/**
 * Statuses that still grant paid access.
 *
 * `canceling` is in here on purpose: it means "cancellation requested, access
 * runs to the end of the period already paid for". Excluding it would strip a
 * paying customer's access the instant they clicked cancel.
 */
const ENTITLING_STATUSES = new Set(['active', 'trialing', 'canceling'])

/** True when the row grants active paid access at the Pro tier or above. */
export function isActivePro(row: { status: string; plan: string; lifetime?: boolean }): boolean {
  return !!row.lifetime
    || (asPlan(row.plan) != null && isAtLeastTier(row.plan as Plan, 'pro')
      && ENTITLING_STATUSES.has(row.status))
}

/**
 * Effective paid access: a paid plan, or the admin role (admins outrank the
 * paywall). Use this for FEATURE gates; keep billing UI (plan badge, manage/
 * upgrade buttons) on `ent.plan` so it stays truthful — an admin without a
 * subscription has Pro access but no subscription to manage.
 */
export function hasProAccess(role: string | null | undefined, ent: Entitlement): boolean {
  return ent.plan !== 'free' || role === 'admin'
}

export type BillingTransition =
  | { kind: 'activated'; userId: string; via: 'subscription' | 'lifetime' }
  | { kind: 'deactivated'; userId: string; reason: 'canceled' | 'refunded' | 'past_due' }
  | { kind: 'payment_failed'; userId: string }

export function translateStripeEvent(event: Stripe.Event): DomainEvent {
  const providerId = 'stripe' as const
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription
      const item = sub.items.data[0]
      const priceId = item?.price?.id ?? null
      return {
        type: 'subscription.upserted',
        eventId: event.id,
        providerId,
        // Subscription events carry no client_reference_id; the row is located by customerId.
        userId: null,
        customerId: String(sub.customer),
        subscriptionId: sub.id,
        status: sub.status,
        plan: tierForProduct('stripe', priceId)?.id ?? null,
        productId: priceId,
        currentPeriodEnd: item?.current_period_end ? item.current_period_end * 1000 : null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        occurredAt: event.created * 1000,
      }
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      return { type: 'subscription.deleted', eventId: event.id, providerId, userId: null, customerId: String(sub.customer), subscriptionId: sub.id, occurredAt: event.created * 1000 }
    }
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const s = event.data.object as Stripe.Checkout.Session
      if (s.mode !== 'payment') return { type: 'ignored', eventId: event.id } // subscription checkout handled via subscription.created
      // 延迟到账支付（ACH/SEPA 等）：completed 时 payment_status 仍是 unpaid，未到账不授终身
      // Pro——到账后 Stripe 会重放为 async_payment_succeeded（走同一翻译）；扣款失败则只有
      // async_payment_failed（无授权可撤，落 default 忽略即可）。
      if (s.payment_status !== 'paid') return { type: 'ignored', eventId: event.id }
      // priceId: null is intentional — the Checkout Session object carries no line-item prices without an expand/fetch,
      // and the grant is plan-agnostic, so null is fine.
      const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id ?? null)
      // The checkout metadata is ours (written at `startCreditCheckout`); when it
      // names a credit pack, this purchase is a credit top-up, not a lifetime
      // grant. Without it, fall back to the legacy price-id lookup (which is
      // effectively null, since `pi` is a payment id, not a product id).
      const metaProductId = typeof s.metadata?.productId === 'string' ? s.metadata.productId : null
      const declaredKind = typeof s.metadata?.kind === 'string' ? s.metadata.kind : null
      const classified = classifyPurchase('stripe', metaProductId)
      if (classified.kind === 'credits') {
        return {
          type: 'credits.purchased',
          eventId: event.id,
          providerId,
          userId: s.client_reference_id ?? null,
          packId: classified.pack.id,
          paymentRef: pi,
        }
      }
      // A session that *says* it is a credit purchase but resolves to no pack is
      // a configuration error (the pack's Stripe product id is blank, or was
      // renamed). Never fall through to the lifetime path here: that would grant
      // Pro to someone who paid for credits. Ignore loudly for manual reconcile.
      if (declaredKind === 'credits') {
        console.error(
          `[billing] Stripe checkout ${s.id} (payment_intent ${pi}) declares kind=credits `
          + `(pack ${String(s.metadata?.packId ?? 'unknown')}) but its productId `
          + `${metaProductId ? `"${metaProductId}"` : '(missing)'} matches no credit pack's configured `
          + `Stripe product id — nothing was granted. Fix creditPacks[].productIds.stripe and reconcile this payment.`,
        )
        return { type: 'ignored', eventId: event.id }
      }
      const productId = metaProductId
      return {
        type: 'purchase.completed',
        eventId: event.id,
        providerId,
        userId: s.client_reference_id ?? null,
        customerId: s.customer ? String(s.customer) : null,
        plan: tierForProduct('stripe', productId ?? pi)?.id ?? null,
        productId,
        paymentRef: pi,
      }
    }
    case 'charge.refunded': {
      const c = event.data.object as Stripe.Charge
      if (!c.refunded && c.amount_refunded !== c.amount) return { type: 'ignored', eventId: event.id } // partial refund → ignore
      const pi = typeof c.payment_intent === 'string' ? c.payment_intent : (c.payment_intent?.id ?? null)
      return { type: 'purchase.refunded', eventId: event.id, providerId, userId: null, customerId: c.customer ? String(c.customer) : null, paymentRef: pi }
    }
    case 'invoice.payment_failed': {
      // 续费扣款失败：发出领域信号，供 app 内提示用户更新支付方式。
      // 重试邮件本身交给 Stripe 的 Smart Retries / Revenue Recovery（见 docs/billing.md）。
      const inv = event.data.object as Stripe.Invoice
      return { type: 'payment.failed', eventId: event.id, providerId, userId: null, customerId: inv.customer ? String(inv.customer) : null, occurredAt: event.created * 1000 }
    }
    default:
      // 其余（invoice.paid / dispute 等）开源版忽略——商业版扩展点。
      return { type: 'ignored', eventId: event.id }
  }
}
