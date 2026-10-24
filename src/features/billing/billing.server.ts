import { and, eq } from 'drizzle-orm'
import type { DB } from '@/db/client'
import { subscription, processedWebhookEvents } from './billing.schema'
import { resolveEntitlement, isActivePro, type DomainEvent, type Entitlement, type BillingTransition } from './entitlement'
import { scopeFromUser, ownedBy } from '@/db/scope'
import { rawD1 } from '@/db/raw'
import type { PaymentProvider } from './payment'
import { runBillingHooks } from './hooks'
import type { ProviderId } from './providers/catalog'
import { disabledProviderReason, getBillingProvider, type BillingEnv } from './providers/registry'
import { isProviderId } from './providers/catalog'
import { creditAccount, creditLedger } from '@/features/credits/credits.schema'
import { applyCreditDelta, grantCredits, type GrantInput } from '@/features/credits/credits.server'
import { packById } from '@/features/credits/credit-packs'
import { resolveCreditPack } from '@/features/credits/credits.core'

/** 读用户 entitlement（经归属缝）。 */
export async function getEntitlementFor(db: DB, userId: string): Promise<Entitlement> {
  const rows = await db.select().from(subscription).where(ownedBy(subscription, scopeFromUser(userId)))
  const row = rows[0]
  return resolveEntitlement(row ? { status: row.status, plan: row.plan, currentPeriodEnd: row.currentPeriodEnd, lifetime: row.lifetime, paymentFailedAt: row.paymentFailedAt, provider: row.provider } : null)
}

/** 定位某事件对应的订阅行。
 *
 *  Waffo / Creem / PayPal 没有我们能预创建的 customer，所以它们靠下单时写进
 *  metadata 的 userId 回传；Stripe 的订阅事件不带任何本地引用，只能按 customerId。
 *  两者皆无的事件无从归属。 */
async function findRowForEvent(db: DB, event: DomainEvent) {
  if (event.type === 'ignored') return undefined
  if (event.type === 'credits.purchased') return undefined // no subscription row for a credit buyer
  if (event.userId) {
    const rows = await db.select().from(subscription).where(ownedBy(subscription, scopeFromUser(event.userId)))
    return rows[0]
  }
  if (event.customerId) {
    const rows = await db.select().from(subscription).where(eq(subscription.customerId, event.customerId))
    return rows[0]
  }
  return undefined
}

/**
 * Reverse a credit-pack purchase whose payment was refunded.
 *
 * Credits are granted by `credits.purchased` with `kind: 'purchase'` and
 * `ref` = the payment reference. A refund is a clawback, not a task consume, so
 * it must not go through `consumeCredits` (that charges a cost and records
 * `kind: 'consume'`). It routes through the credits module's `applyCreditDelta`
 * instead, which is the *only* place that owns the guarded UPDATE + ledger
 * INSERT pair — so a refund gets the same atomic `balanceAfter` snapshot and the
 * same `lifetime_*` bookkeeping as every other movement.
 *
 * **Clamping.** The grant is clamped to the remaining balance: if the buyer spent
 * part of the pack before the refund, only what is still there is reversed, and
 * the ledger note records the actual reversed amount.
 *
 * **Return value.** `true` means "this refund is a credit matter, the caller must
 * NOT run the lifetime-subscription refund path" — including the case where the
 * pack was fully spent and there is nothing left to claw back (the refund is
 * still a credit refund; falling through would wrongly revoke a subscription).
 * `false` means "no credit purchase matched at all", so the caller proceeds with
 * the normal lifetime logic.
 *
 * If the credits slice's tables are not migrated (a fixture applying only the
 * billing schema, or a not-yet-migrated deployment), the lookup is skipped and
 * this returns false — a refund must never 500 over an absent optional table.
 */
async function reverseCreditPurchase(
  db: DB,
  event: Extract<DomainEvent, { type: 'purchase.refunded' }>,
  now: number,
): Promise<boolean> {
  // Without a payment reference we cannot match a purchase, and cannot build a
  // stable idempotency key either — leave the lifetime path alone.
  if (!event.paymentRef) return false

  const idempotencyKey = `refund:${event.providerId}:${event.paymentRef}`

  // Guard: the credit ledger belongs to the credits slice. A fixture that
  // applies only the billing schema (or a not-yet-migrated deployment) has no
  // `credit_ledger`, and a refund must never 500 because of that.
  const probe = await rawD1(db)
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credit_ledger'`)
    .all()
  if (!probe.results || probe.results.length === 0) return false

  // Locate the purchase rows. Prefer the event's own userId (Waffo/Creem/PayPal
  // echo it back); Stripe's charge.refunded carries only a customerId, which
  // usually has no subscription row for a credit buyer — so match on `ref` and
  // narrow by userId only when the event supplies one. The ledger row's own
  // `user_id` is authoritative for which account to debit.
  const purchases = await db
    .select({ userId: creditLedger.userId, delta: creditLedger.delta })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.kind, 'purchase'),
        eq(creditLedger.ref, event.paymentRef),
        ...(event.userId ? [eq(creditLedger.userId, event.userId)] : []),
      ),
    )
  if (purchases.length === 0) return false

  // `$ref` can in principle span accounts; reverse only the row that actually
  // received the grant rather than trusting `[0]`. Sum per user, then take the
  // one with the largest grant (a single payment always credits one account).
  const grantedByUser = new Map<string, number>()
  for (const row of purchases) {
    grantedByUser.set(row.userId, (grantedByUser.get(row.userId) ?? 0) + Math.max(0, row.delta))
  }
  let targetUserId = ''
  let granted = 0
  for (const [userId, amount] of grantedByUser) {
    if (amount > granted) {
      granted = amount
      targetUserId = userId
    }
  }
  if (granted <= 0 || !targetUserId) return false

  // `applyCreditDelta`'s own guard refuses a debit that would go negative, so
  // asking for the full grant is safe: whatever remains is what gets reversed.
  // Read the balance first only to decide whether a clamp happened, for the note.
  const accountRows = await db
    .select({ balance: creditAccount.balance })
    .from(creditAccount)
    .where(ownedBy(creditAccount, scopeFromUser(targetUserId)))
  const balance = accountRows[0]?.balance ?? 0
  const reversed = Math.min(granted, Math.max(0, balance))

  const note = reversed < granted
    ? `refund of credit pack purchase, clamped from ${granted} to remaining balance ${reversed}`
    : 'refund of credit pack purchase'

  if (reversed > 0) {
    await applyCreditDelta(db, {
      userId: targetUserId,
      delta: -reversed,
      kind: 'refund',
      idempotencyKey,
      ref: event.paymentRef,
      note,
      now,
    })
    return true
  }

  // Nothing left to claw back (the pack was fully spent). This is still a credit
  // refund — returning false here would hand the event to the lifetime path and
  // wrongly revoke the buyer's subscription. Record a zero-value ledger row so
  // the refund is auditable and idempotent, then stop.
  await applyCreditDelta(db, {
    userId: targetUserId,
    delta: 0,
    kind: 'refund',
    idempotencyKey,
    ref: event.paymentRef,
    note: `refund of credit pack purchase, nothing left to reclaim (granted ${granted}, balance 0)`,
    now,
  })
  return true
}

/** 应用领域事件到订阅表（系统级，按 userId/customerId 定位）。返回发生的状态跃迁（供回调），无跃迁则 null。
 *  cancelSubscription：取消/买断时用于终止在生效中的订阅（须幂等）。先取消后授予——
 *  取消失败即抛错，让 webhook 返回 500 触发重投，避免订阅在买断后继续扣费。 */
export async function applyDomainEvent(
  db: DB,
  event: DomainEvent,
  now: number,
  cancelSubscription?: (subscriptionId: string) => Promise<void>,
): Promise<BillingTransition | null> {
  if (event.type === 'ignored') return null

  // Credit-pack purchases are a separate ledger concern, not a subscription:
  // they must be handled before the row lookup, because a credit buyer often
  // has no subscription row at all.
  if (event.type === 'credits.purchased') {
    if (!event.userId) {
      console.error(`[billing] credits.purchased event ${event.eventId} carries no user — no credits granted`)
      return null
    }
    const pack = packById(event.packId)
    if (!pack) {
      console.error(
        `[billing] credits.purchased event ${event.eventId} references unknown credit pack "${event.packId}" — `
        + `no credits granted for user ${event.userId}. The customer was charged; fix creditPacks[].`,
      )
      return null
    }
    // `paymentRef` is the ONLY stable identifier for a payment. Falling back to
    // `eventId` would defeat idempotency: a webhook retry arrives as a *new*
    // eventId, so the second delivery would look unique and grant twice. Refuse
    // the grant and shout instead — the customer was charged, so this needs a
    // human to reconcile, but a silent double-grant is worse than a loud miss.
    if (!event.paymentRef) {
      console.error(
        `[billing] credits.purchased event ${event.eventId} carries no paymentRef — cannot build a `
        + `stable idempotency key, so no credits were granted for user ${event.userId} `
        + `(pack ${event.packId}). Reconcile this payment manually.`,
      )
      return null
    }
    // The credits server's guarded UPDATE/INSERT requires the account row to
    // exist; create it without granting the monthly allowance (a purchase is
    // not a plan entitlement).
    await db.insert(creditAccount).values({
      userId: event.userId,
      balance: 0,
      periodGrant: 0,
      lifetimePurchased: 0,
      lifetimeConsumed: 0,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    }).onConflictDoNothing()
    const grant: GrantInput = {
      userId: event.userId,
      delta: pack.credits,
      kind: 'purchase',
      idempotencyKey: `credits:${event.providerId}:${event.paymentRef}`,
      ref: event.paymentRef,
      note: `credit pack ${event.packId}`,
    }
    await grantCredits(db, grant, now)
    return null
  }

  // A refund is checked against the credit ledger first: if it refunds a
  // credit-pack purchase, it is a clawback and must not fall through to the
  // lifetime-subscription refund path below.
  if (event.type === 'purchase.refunded') {
    const reversed = await reverseCreditPurchase(db, event, now)
    if (reversed) return null
  }

  const row = await findRowForEvent(db, event)
  if (!row) return null // 无映射的用户/客户 → 忽略

  // 跨厂商守卫：行的 provider 决定谁有权改它。用户可能先用 Stripe 付过、
  // 后来换 Waffo 重新付费，旧厂商迟到的事件不得把行改回去（否则一次升级
  // 会因为一条几小时前的旧事件把新订阅降级）。
  if (row.provider !== event.providerId) return null

  const occurredAt = 'occurredAt' in event ? event.occurredAt : undefined
  const wasPro = isActivePro(row)

  // 跨订阅对象防护（在乱序守卫之前——它不改行状态，陈旧时间戳不该让并发订阅逃过取消）：
  // Checkout Session 有效期 24h 且完成时无二次守卫，双标签页并发、或「先买断/新订阅、再补付
  // 旧 session」都会在商家侧产生第二个活订阅。行上已有授权（终身买断或另一个活订阅）时，
  // 来件的陌生订阅一律幂等取消——否则它不入库、无人追踪、永久扣费。
  if (event.type === 'subscription.upserted'
      && (row.lifetime || (row.subscriptionId != null && row.subscriptionId !== event.subscriptionId && wasPro))) {
    const alreadyDead = event.status === 'canceled' || event.status === 'incomplete_expired' || event.status === 'canceling'
    if (!alreadyDead && cancelSubscription) await cancelSubscription(event.subscriptionId)
    return null
  }
  // 上面取消并发订阅后商家会回发它的删除事件——不是行上跟踪的订阅，忽略，
  // 别把真订阅的行状态砸成 canceled。
  if (event.type === 'subscription.deleted' && row.subscriptionId != null && row.subscriptionId !== event.subscriptionId) return null

  // 乱序守卫：比已应用事件更旧的订阅流事件直接丢弃（如删除之后才重投到达的
  // 更新-激活，若照单全收会把已取消的订阅复活成永久免费 Pro）。
  if (occurredAt != null && row.lastEventAt != null && occurredAt < row.lastEventAt) return null

  if (event.type === 'purchase.completed') {
    if (row.subscriptionId && cancelSubscription) await cancelSubscription(row.subscriptionId)
    await db.update(subscription).set({
      lifetime: true,
      plan: event.plan && event.plan !== 'free' ? event.plan : 'pro',
      status: 'active', subscriptionId: null,
      lifetimePaymentRef: event.paymentRef ?? null,
      priceId: event.productId ?? row.priceId, currentPeriodEnd: null, updatedAt: new Date(now),
      paymentFailedAt: null, // 买断替代了订阅，催缴横幅随之失效（否则日后退款回 free 时它会复活）
    }).where(eq(subscription.id, row.id))
    return wasPro ? null : { kind: 'activated', userId: row.userId, via: 'lifetime' }
  }
  if (event.type === 'purchase.refunded') {
    // 已知限制：若退款事件先于授予事件到达（completed 首投失败重试期间管理员退款），此处
    // 无行可撤、被静默跳过，迟到的授予随后照常生效——闭合它需要一张退款台账，模板不引入。
    if (!row.lifetime) return null // 订阅退款不在此处理
    // 只有退的是买断那笔付款才撤授权——同客户其他 charge 的退款与终身授权无关。
    // 任一侧引用缺失（老数据/老事件）时保守回退到按客户匹配。
    if (row.lifetimePaymentRef && event.paymentRef && event.paymentRef !== row.lifetimePaymentRef) return null
    await db.update(subscription).set({
      lifetime: false, plan: 'free', status: 'canceled', paymentFailedAt: null, updatedAt: new Date(now),
    }).where(eq(subscription.id, row.id))
    return { kind: 'deactivated', userId: row.userId, reason: 'refunded' }
  }

  if (row.lifetime) return null // 终身授权不被订阅事件/扣款失败降级或改写

  if (event.type === 'payment.failed') {
    // 续费扣款失败：置 flag 供 app 内 banner 提示；重试邮件交给厂商自己的 dunning 流程。
    // flag 清除于恢复扣款（见 subscription.upserted）。
    // 注意：不推进 lastEventAt——发票流与订阅流是两条独立事件流、几乎同时发出，若用扣款失败的
    // 时间戳污染订阅流时钟，会把同一秒稍早的 updated(past_due) 永久丢弃（用户整个催缴期保持 Pro）。
    // 本事件仍受时钟守卫（陈旧的失败不该盖掉更新的恢复），只是不写它。
    await db.update(subscription).set({ paymentFailedAt: now, updatedAt: new Date(now) }).where(eq(subscription.id, row.id))
    return { kind: 'payment_failed', userId: row.userId }
  }

  if (event.type === 'subscription.upserted') {
    // 档位来自事件本身（由 provider 用 plans.ts 反查商品 ID 得到），查不到就沿用行上的值。
    const plan = event.plan ?? row.plan
    // 查不到商品 ID 说明 plans.ts 与商家后台对不上——顾客已经在扣款,但我们无法确定
    // 他买的是哪一档。这绝不能静默:不授权是对的(宁可让运营发现,也不能按错的档位放行),
    // 但必须喊出来,否则就是一个「付了钱什么都没拿到」的工单。
    // env-validate 会在启动时对「一个商品 ID 都没配」的情况告警;这条覆盖的是
    // 「配了、但漏了这一档」的部分配置。
    if (event.plan == null && event.productId && !isActivePro(row)) {
      console.error(
        `[billing] ${event.providerId} reported an unknown product id "${event.productId}" — it is not in plans.ts, `
        + `so no plan was granted for user ${row.userId} (subscription ${event.subscriptionId}). `
        + 'The customer is being charged. Add the id to planTiers[].productIds.',
      )
    }
    const recovered = event.status === 'active' || event.status === 'trialing' // 扣款恢复 → 清除失败 flag
    await db.update(subscription).set({
      subscriptionId: event.subscriptionId, status: event.status, plan,
      priceId: event.productId ?? row.priceId, currentPeriodEnd: event.currentPeriodEnd,
      cancelAtPeriodEnd: event.cancelAtPeriodEnd, updatedAt: new Date(now),
      paymentFailedAt: recovered ? null : row.paymentFailedAt,
      lastEventAt: occurredAt ?? row.lastEventAt,
    }).where(eq(subscription.id, row.id))
    const nowPro = isActivePro({ status: event.status, plan, lifetime: false })
    if (!wasPro && nowPro) return { kind: 'activated', userId: row.userId, via: 'subscription' }
    if (wasPro && !nowPro) return { kind: 'deactivated', userId: row.userId, reason: 'past_due' }
    return null
  }
  if (event.type === 'subscription.deleted') {
    await db.update(subscription).set({
      status: 'canceled', plan: 'free', subscriptionId: null, updatedAt: new Date(now),
      lastEventAt: occurredAt ?? row.lastEventAt,
      paymentFailedAt: null, // 订阅已死，「更新支付方式」横幅不该跟着免费用户一辈子
    }).where(eq(subscription.id, row.id))
    return wasPro ? { kind: 'deactivated', userId: row.userId, reason: 'canceled' } : null
  }
  return null
}

/** 开始结账：确保 customer 存在 + upsert subscription 行 + 创建托管收银台。
 *
 *  `productId` 必须已经过 `availableProvidersForTier` 校验——本函数信任调用方，
 *  校验放在 server fn 边界而不是这里，避免同一份校验散落在多处。 */
export async function startCheckout(
  db: DB,
  provider: PaymentProvider,
  user: { id: string; email: string },
  productId: string,
  successUrl: string,
  cancelUrl: string,
  now: number,
  mode: 'subscription' | 'payment' = 'subscription',
  plan: string = 'pro',
): Promise<{ url: string }> {
  const rows = await db.select().from(subscription).where(ownedBy(subscription, scopeFromUser(user.id)))
  const existing = rows[0]
  // 已是活跃付费用户 → 拒绝：再开一单会产生第二个并发订阅（双扣费），
  // 换套餐/续费的正途是客户门户或取消后重买。
  if (existing && isActivePro(existing)) {
    throw new Error('already subscribed — manage the plan from your account page instead')
  }
  const customerId = await provider.ensureCustomer(user, existing?.customerId ?? null)
  // provider 一并落库：webhook 到达时要靠它确认「这条事件有权改这一行」，
  // 取消也要靠它选出正确的适配器。
  const providerChanged = existing != null && existing.provider !== provider.id
  if (!existing) {
    await db.insert(subscription).values({
      id: crypto.randomUUID(),
      userId: user.id,
      provider: provider.id,
      customerId,
      subscriptionId: null,
      status: 'none',
      plan: 'free',
      cancelAtPeriodEnd: false,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
  } else if (existing.customerId !== customerId || providerChanged) {
    await db.update(subscription)
      .set({ customerId, provider: provider.id, updatedAt: new Date(now) })
      .where(eq(subscription.id, existing.id))
  }
  return provider.createCheckoutSession({
    userId: user.id,
    userEmail: user.email,
    customerId,
    productId,
    successUrl,
    cancelUrl,
    mode,
    // 回传给 webhook：这三家没有可预建的 customer，这是把付款归属回本地用户的唯一通道。
    metadata: { userId: user.id, plan, provider: provider.id },
  })
}

/**
 * 开始一次 credit pack 结账：解析 pack → provider 的商品 id，创建托管收银台。
 *
 * 与 `startCheckout` 的关键区别：**不写 subscription 表**。Credit pack 是计量
 * 购买，不授予任何 plan 档位；付款归属完全靠 `metadata.userId` 回传（`credits.purchased`
 * 用它定位用户）。只读 subscription 行上的 `customerId` 以便复用 Stripe customer，
 * 但绝不 upsert——否则一个只买 credits 的 free 用户会被记成 `plan: 'free'` 的
 * subscription 行，与「无订阅」的 entitlement 语义冲突。
 *
 * `resolveCreditPack` 是唯一的权限判断：本函数信任调用方传入的 provider 实例，
 * 但 pack 的合法性与该 provider 是否在卖它，一律由它裁决。 */
export async function startCreditCheckout(
  db: DB,
  provider: PaymentProvider,
  user: { id: string; email: string },
  packId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<{ url: string }> {
  const { env } = await import('@/lib/env')
  const billingEnv = env as unknown as BillingEnv
  const pack = packById(packId)
  if (!pack) throw new Error(`Unknown credit pack: ${packId}`)
  const resolved = resolveCreditPack(billingEnv, pack, provider.id)
  if (!resolved.ok) throw new Error(resolved.reason)

  // 只读：复用已有 customer，但绝不写 subscription 行。
  const rows = await db.select({ customerId: subscription.customerId }).from(subscription)
    .where(ownedBy(subscription, scopeFromUser(user.id)))
  const customerId = rows[0]?.customerId ?? null

  return provider.createCheckoutSession({
    userId: user.id,
    userEmail: user.email,
    customerId,
    productId: resolved.productId,
    successUrl,
    cancelUrl,
    mode: 'payment',
    // 回传：这三家没有可预建的 customer，这是把付款归属回本地用户的唯一通道。
    //
    // `productId` **必须**在这里回传：Stripe 的 `checkout.session.completed` 事件体
    // 不含 line-item price（除非额外 expand），`translateStripeEvent` 无从得知买了
    // 什么。没有它就退化成 `classifyPurchase('stripe', null) === 'unknown'`，而这
    // 笔交易会被当作终身 Pro 授予——credit pack 被静默错授。
    // `packId` / `kind` 仅供审计与其它 provider 使用，路由只认 `productId`。
    metadata: {
      kind: 'credits',
      packId,
      productId: resolved.productId,
      userId: user.id,
      provider: provider.id,
    },
  })
}

/** 删号前清理：取消该用户在生效中的订阅。行会随删号级联消失、customerId 映射
 *  一去不返，届时商家侧的活订阅将永远无法对账或停止——所以必须在删除前终止。
 *  抛错让删除中止：宁可删不掉，也不能留下无人认领的僵尸扣费。 */
export async function cancelSubscriptionsForUser(
  db: DB,
  cancelSubscription: (subscriptionId: string) => Promise<void>,
  userId: string,
): Promise<void> {
  const rows = await db.select().from(subscription).where(ownedBy(subscription, scopeFromUser(userId)))
  const row = rows[0]
  if (row?.subscriptionId) await cancelSubscription(row.subscriptionId)
}

/**
 * Which vendor adapter owns this user's subscription.
 *
 * Three outcomes, all distinct and all handled by callers:
 *   - `null` — the user never had a subscription row; nothing to cancel.
 *   - `{ ok: false }` — the row exists but that vendor is no longer configured
 *     on this Worker. Callers must warn rather than silently succeed.
 *   - `{ ok: true }` — a usable adapter.
 */
export async function getProviderForUser(
  db: DB,
  userId: string,
): Promise<{ ok: true; value: PaymentProvider } | { ok: false; storedProvider: string; reason: string } | null> {
  const rows = await db.select().from(subscription).where(ownedBy(subscription, scopeFromUser(userId)))
  const row = rows[0]
  if (!row) return null
  const { env } = await import('@/lib/env')
  const billingEnv = env as unknown as BillingEnv
  // Validate rather than cast: this column is free text, and a row written by a
  // build that knew a vendor we no longer do must degrade with a message, not throw.
  if (!isProviderId(row.provider)) {
    return {
      ok: false,
      storedProvider: row.provider,
      reason: `This subscription was created by "${row.provider}", which this build does not recognise.`,
    }
  }
  const id = row.provider
  const reason = disabledProviderReason(billingEnv, id)
  if (reason) return { ok: false, storedProvider: row.provider, reason }
  try {
    return { ok: true, value: getBillingProvider(billingEnv, id) }
  } catch (err) {
    return { ok: false, storedProvider: row.provider, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** 打开客户门户（仅 Stripe 提供）。 */
export async function openPortal(
  db: DB,
  provider: PaymentProvider,
  userId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  if (!provider.supportsPortal) {
    throw new Error(`${provider.displayName} has no billing portal — cancel from the account page instead`)
  }
  const rows = await db.select().from(subscription).where(ownedBy(subscription, scopeFromUser(userId)))
  const row = rows[0]
  if (!row?.customerId) throw new Error('No subscription/customer for user')
  return provider.createPortalSession(row.customerId, returnUrl)
}

/**
 * 站内取消订阅（非门户厂商）。
 *
 * **只写 `canceling`，绝不写终态。** 终态（`canceled` / 降级 free）一律由厂商 webhook
 * 写入——那是唯一权威的来源，也避免「我们说取消了、厂商其实没取消」这种分叉。
 *
 * 那为什么还要本地写一次 `canceling`？因为刷新页面时它比 `active` 诚实：用户点了取消、
 * 厂商还没回 webhook 时，行上写着 `active` 会让人以为没点上，而 `canceling` 至少和真实
 * 意图一致。它永远不会自行降级，webhook 到达后会覆盖它。
 *
 * 已知取舍：若 webhook 丢失（签名校验 400 这类不会被重投的情况），行会停在 `canceling`。
 * 这是刻意的——停在 `canceling` 会被用户看见并重试；停在 `active` 则会静默地继续扣费。
 *
 * 商家侧取消先于本地写入：取消失败即抛错，不留下「本地说在取消中、厂商根本没收到」的假状态。
 * 厂商取消须幂等，所以用户连点两次、或 webhook 重投再次取消，都不会出问题。
 */
export async function cancelSubscriptionForUser(
  db: DB,
  provider: PaymentProvider,
  userId: string,
  now: number,
): Promise<{ cancelMode: 'immediate' | 'at_period_end' }> {
  const rows = await db.select().from(subscription).where(ownedBy(subscription, scopeFromUser(userId)))
  const row = rows[0]
  if (!row) throw new Error('No subscription for user')
  if (row.provider !== provider.id) {
    throw new Error(`Subscription belongs to ${row.provider}, not ${provider.id}`)
  }
  if (row.status === 'canceled' || row.status === 'canceling') {
    throw new Error('This subscription is already being canceled')
  }
  if (row.subscriptionId) await provider.cancelSubscription(row.subscriptionId)

  // 只标记意图。`cancelAtPeriodEnd` 一并记下，这样即便 webhook 迟到，账户页也不会把
  // 这个订阅显示成「正常续费中」。
  await db.update(subscription).set({
    status: 'canceling',
    cancelAtPeriodEnd: provider.cancelMode === 'at_period_end',
    paymentFailedAt: null,
    updatedAt: new Date(now),
  }).where(eq(subscription.id, row.id))

  return { cancelMode: provider.cancelMode }
}

/** pending 认领超过此时长视为死亡执行，允许重试接管（Worker 单请求远短于 60s）。 */
const STALE_CLAIM_MS = 60_000

/**
 * webhook 编排：验签（由 parse 负责）→幂等认领→落库→标记落定→（成功后）best-effort 触发跃迁回调。
 * 返回 HTTP 状态码。
 *
 * `providerId` 只用于给幂等键加命名空间（`${providerId}:${eventId}`）——四家的事件 ID
 * 各自独立，混在一个表里必须有这个前缀才不会互相吞掉对方的重投。
 */
export async function handleWebhook(
  db: DB,
  providerId: ProviderId,
  parse: (rawBody: string, headers: Record<string, string | null>) => Promise<DomainEvent>,
  rawBody: string,
  headers: Record<string, string | null>,
  now: number,
  apply: (db: DB, event: DomainEvent, now: number) => Promise<BillingTransition | null | void> = applyDomainEvent,
  onTransition: (db: DB, t: BillingTransition) => Promise<void> = runBillingHooks,
): Promise<number> {
  let event: DomainEvent
  try {
    event = await parse(rawBody, headers)
  } catch {
    return 400 // 验签失败
  }
  // ignored 事件无副作用可保护，不占幂等表（否则账户上每个无关事件都永久留痕）。
  if (event.type === 'ignored') return 200
  const eventId = `${providerId}:${event.eventId}`
  // 两段式认领：先插 pending 标记占坑，apply 成功后翻 done。D1 无跨语句事务，
  // 若在两步之间被杀，标记会永远停在 pending——靠「陈旧 pending 可被重试接管」闭合窗口，
  // 否则厂商重投撞唯一约束直接 200，事件被应答却从未应用。
  try {
    await db.insert(processedWebhookEvents).values({ eventId, processedAt: new Date(now), status: 'pending' })
  } catch {
    const markers = await db.select().from(processedWebhookEvents).where(eq(processedWebhookEvents.eventId, eventId))
    const marker = markers[0]
    if (!marker) return 500 // 插入失败却查无标记：瞬时故障 → 让厂商重试
    if (marker.status === 'done') return 200 // 重复投递 → 幂等跳过
    // in-flight 双胞胎：应答 500 让厂商稍后重投——认领者若成功，重投会看到 done→200；
    // 若认领者被杀（isolate 驱逐/CPU 超限，无任何应答），标记变陈旧后由重投接管。
    // 此处若应答 200，认领者死亡 + 重投恰落在 60s 窗口内时，事件会被应答却永远没被应用。
    if (now - marker.processedAt.getTime() < STALE_CLAIM_MS) return 500
    // 陈旧 pending = 上次执行死在认领与落库之间 → 接管重跑
    await db.update(processedWebhookEvents).set({ processedAt: new Date(now) }).where(eq(processedWebhookEvents.eventId, eventId))
  }
  let transition: BillingTransition | null | void
  try {
    transition = await apply(db, event, now)
  } catch {
    // compensate: remove the marker so the provider's retry re-applies
    try { await db.delete(processedWebhookEvents).where(eq(processedWebhookEvents.eventId, eventId)) } catch { /* best effort */ }
    return 500
  }
  // apply 成功 → 落定标记。此步失败也返回 200：apply 是幂等的，标记留在 pending，
  // 下一次同 eventId 投递（若有）会在变陈旧后无害地重跑。
  try {
    await db.update(processedWebhookEvents).set({ status: 'done' }).where(eq(processedWebhookEvents.eventId, eventId))
  } catch (e) { console.error('[billing] failed to finalize webhook marker', e) }
  if (transition) {
    // 副作用 best-effort：回调失败不影响 webhook 返回 200（否则会触发厂商重投 → 重复副作用）
    try { await onTransition(db, transition) } catch (e) { console.error('[billing-hooks] onTransition failed', e) }
  }
  return 200
}
