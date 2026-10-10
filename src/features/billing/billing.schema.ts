import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { user } from '@/features/auth/auth.schema'

export const subscription = sqliteTable('subscription', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
  // Which vendor owns this row: 'stripe' | 'waffo' | 'creem' | 'paypal'.
  // Decides portal vs in-app cancel, and gates inbound webhooks — an event from
  // a vendor that does not own the row is ignored (see applyDomainEvent).
  provider: text('provider').notNull().default('stripe'),
  // Nullable because PayPal exposes no stable customer id we can pre-create.
  customerId: text('customer_id'),
  // Vendor-side subscription identifier (Stripe sub_… / Waffo orderId /
  // Creem subscription id / PayPal I-…). What cancelSubscription receives.
  subscriptionId: text('subscription_id'),
  status: text('status').notNull().default('none'),
  // 'free' | 'pro' | 'enterprise'. Text rather than an enum so plans.ts can gain
  // a tier without a migration.
  plan: text('plan').notNull().default('free'),
  // Vendor-side product/plan id, resolved from plans.ts. Kept for display and
  // reconciliation; authority always lives in plans.ts.
  priceId: text('price_id'),
  currentPeriodEnd: integer('current_period_end'),            // epoch ms
  cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' }).notNull().default(false),
  lifetime: integer('lifetime', { mode: 'boolean' }).notNull().default(false),
  // The payment reference for a one-time purchase: Stripe payment_intent id,
  // Waffo orderId, Creem checkout id, PayPal capture id. Refunds are matched
  // exactly against this so an unrelated refund on the same account cannot
  // revoke a grant it has nothing to do with.
  lifetimePaymentRef: text('lifetime_payment_ref'),

  paymentFailedAt: integer('payment_failed_at'),              // epoch ms；非空 = 续费扣款失败待用户处理（清除于恢复扣款）
  lastEventAt: integer('last_event_at'),                      // epoch ms；已应用的最新订阅流事件时间（乱序守卫，见 applyDomainEvent）
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [
  index('subscription_customer_id_idx').on(t.customerId), // 每个 Stripe webhook 都按 customerId 查行——热路径
])

export const processedWebhookEvents = sqliteTable('processed_webhook_events', {
  eventId: text('event_id').primaryKey(),
  processedAt: integer('processed_at', { mode: 'timestamp_ms' }).notNull(),
  // 'pending' = 已认领未落库（apply 中/曾中途死掉）；'done' = 已应用。D1 无跨语句事务，
  // 认领与落库间的宕机窗口靠「陈旧 pending 可被重试接管」闭合（见 handleWebhook）。
  status: text('status').notNull().default('done'),
})

export type Subscription = typeof subscription.$inferSelect
