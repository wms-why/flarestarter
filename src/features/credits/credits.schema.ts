import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { user } from '@/features/auth/auth.schema'

/** 每个用户一行；余额是「用账本可重算」的物化缓存，永不为负（由 guarded UPDATE 保证）。 */
export const creditAccount = sqliteTable('credit_account', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  balance: integer('balance').notNull().default(0),
  /** 已发放额度的周期（UTC 日历月 'YYYY-MM'）；用于月度发放幂等与惰性补发判断。 */
  periodKey: text('period_key'),
  /** 该周期实际发放额（升级补差以此计算增量）。 */
  periodGrant: integer('period_grant').notNull().default(0),
  lifetimePurchased: integer('lifetime_purchased').notNull().default(0),
  lifetimeConsumed: integer('lifetime_consumed').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/** 只追加的积分账本——退款、人工调账、用户申诉的审计事实源。 */
export const creditLedger = sqliteTable('credit_ledger', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  /** 正=发放/充值，负=消费/退款/调账。 */
  delta: integer('delta').notNull(),
  balanceAfter: integer('balance_after').notNull(),
  /** 'grant.monthly' | 'grant.upgrade' | 'purchase' | 'consume' | 'refund' | 'adjust' */
  kind: text('kind').notNull(),
  /** 幂等/并发闸门：唯一索引。同 key 只入账一次。 */
  idempotencyKey: text('idempotency_key').notNull().unique(),
  /** 支付参考号 / 任务 id / 操作管理员 id。 */
  ref: text('ref'),
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [
  index('credit_ledger_user_created_idx').on(t.userId, t.createdAt),
  index('credit_ledger_ref_idx').on(t.ref),
])

export type CreditAccount = typeof creditAccount.$inferSelect
export type CreditLedgerRow = typeof creditLedger.$inferSelect
export type CreditLedgerKind = 'grant.monthly' | 'grant.upgrade' | 'purchase' | 'consume' | 'refund' | 'adjust'
