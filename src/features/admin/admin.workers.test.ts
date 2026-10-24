/**
 * Admin workers integration tests — real Cloudflare D1 (workerd/miniflare).
 *
 * 5 intents:
 *  1. bootstrap    — sign-up with ADMIN_EMAILS address → role='admin'; other → role='user'
 *  2. access ctrl  — normal user calling listUsers → rejected; admin → returns list
 *  3. ban/unban    — banUser → banned truthy; sign-in rejected; unbanUser → cleared, sign-in works
 *  4. impersonate  — impersonateUser → session.impersonatedBy = admin id; stopImpersonating → cleared
 *  5. stats        — seed users/sessions/subscriptions → getAdminStats counts match
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { createDb } from '@/db/client'
import { user as userTable, session as sessionTable } from '@/features/auth/auth.schema'
import { applyAuthSchema, createTestAuth, extractToken, extractCookie } from '@/features/auth/test-helpers'
import { applyCreditsSchema } from '@/features/credits/test-helpers'
import { getAdminStats } from './getAdminStats'

// ---------------------------------------------------------------------------
// Test ADMIN_EMAILS value
// ---------------------------------------------------------------------------
const TEST_ADMIN_EMAILS = 'admin@test.com'

// ---------------------------------------------------------------------------
// Schema bootstrap — runs once before all tests
// ---------------------------------------------------------------------------
beforeAll(async () => {
  await applyAuthSchema(env.DB)
  // Credit tables (for the credits section of the admin stats view)
  await applyCreditsSchema(env.DB)
  // Billing subscription table (for intent 5 stats)
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS "subscription" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "user_id" TEXT NOT NULL UNIQUE,
      "provider" TEXT NOT NULL DEFAULT 'stripe',
      "customer_id" TEXT NOT NULL,
      "subscription_id" TEXT,
      "status" TEXT NOT NULL DEFAULT 'none',
      "plan" TEXT NOT NULL DEFAULT 'free',
      "price_id" TEXT,
      "current_period_end" INTEGER,
      "cancel_at_period_end" INTEGER NOT NULL DEFAULT 0,
      "created_at" INTEGER NOT NULL,
      "updated_at" INTEGER NOT NULL,
      FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE
    )`,
  ).run()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cookieHeaders(cookie: string): Headers {
  return new Headers({ cookie })
}

/**
 * Extract ALL Set-Cookie values from a response and join them into a single
 * Cookie header string suitable for subsequent requests.
 * Uses getSetCookie() where available (workerd), falls back to get('set-cookie').
 * Filters out expired/cleared cookies (empty values).
 */
function extractAllCookies(response: Response): string {
  let pairs: string[]

  // getSetCookie() returns each Set-Cookie as a separate string (no mangling)
  if (typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function') {
    const all = (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
    // Convert Set-Cookie values (name=value; opts) to Cookie header values (name=value)
    pairs = all.map((sc) => sc.split(';')[0].trim())
  } else {
    // Fallback: use get() which joins with comma (may mangle values with commas)
    const raw = response.headers.get('set-cookie') ?? ''
    pairs = raw.split(',').map((part) => part.trim().split(';')[0].trim())
  }

  // Filter out empty-value cookies (clearing/expiry directives like `name=; expires=...`)
  return pairs
    .filter((pair) => {
      const eqIdx = pair.indexOf('=')
      if (eqIdx === -1) return false
      const value = pair.slice(eqIdx + 1).trim()
      return value.length > 0
    })
    .join('; ')
}

// ---------------------------------------------------------------------------
// Intent 1: bootstrap — admin role assigned on sign-up for ADMIN_EMAILS
// ---------------------------------------------------------------------------
describe('1. bootstrap: ADMIN_EMAILS → role assignment on sign-up', () => {
  test('admin@test.com gets role=admin; normal@test.com gets role=user', async () => {
    const db = createDb(env.DB)
    const { auth: adminAuth, sentEmails: adminEmails } = createTestAuth(db, TEST_ADMIN_EMAILS)
    const { auth: normalAuth, sentEmails: normalEmails } = createTestAuth(db, TEST_ADMIN_EMAILS)

    const adminEmail = 'admin@test.com'
    const normalEmail = 'normal-bootstrap@test.com'
    const password = 'Password123!'

    // Sign up admin
    await adminAuth.api.signUpEmail({
      body: { email: adminEmail, password, name: 'Admin User' },
      asResponse: true,
    })
    // Verify admin email
    const adminVerification = adminEmails.find((e) => e.to === adminEmail)
    expect(adminVerification).toBeDefined()
    await adminAuth.api.verifyEmail({ query: { token: extractToken(adminVerification!.url) }, asResponse: true })

    // Sign up normal user
    await normalAuth.api.signUpEmail({
      body: { email: normalEmail, password, name: 'Normal User' },
      asResponse: true,
    })
    // Verify normal email
    const normalVerification = normalEmails.find((e) => e.to === normalEmail)
    expect(normalVerification).toBeDefined()
    await normalAuth.api.verifyEmail({ query: { token: extractToken(normalVerification!.url) }, asResponse: true })

    // Assert roles in DB
    const adminRows = await db.select().from(userTable).where(eq(userTable.email, adminEmail))
    const normalRows = await db.select().from(userTable).where(eq(userTable.email, normalEmail))

    expect(adminRows).toHaveLength(1)
    expect(adminRows[0].role).toBe('admin')

    expect(normalRows).toHaveLength(1)
    expect(normalRows[0].role).toBe('user')
  })
})

// ---------------------------------------------------------------------------
// Intent 2: access control — listUsers rejects non-admin, allows admin
// ---------------------------------------------------------------------------
describe('2. access control: listUsers requires admin session', () => {
  test('non-admin session → 403; admin session → returns user list', async () => {
    const db = createDb(env.DB)

    // Register admin (reuse from intent 1; may already exist — create fresh with unique suffix)
    const adminSuffix = `ac-admin-${crypto.randomUUID().slice(0, 8)}`
    const adminEmail = `${adminSuffix}@test.com`
    const { auth, sentEmails } = createTestAuth(db, adminEmail)
    const password = 'Password123!'

    await auth.api.signUpEmail({
      body: { email: adminEmail, password, name: 'AC Admin' },
      asResponse: true,
    })
    const adminVE = sentEmails.find((e) => e.to === adminEmail)!
    await auth.api.verifyEmail({ query: { token: extractToken(adminVE.url) }, asResponse: true })

    // Register a normal user on the SAME auth instance
    const normalEmail = `ac-normal-${crypto.randomUUID().slice(0, 8)}@example.com`
    await auth.api.signUpEmail({
      body: { email: normalEmail, password, name: 'AC Normal' },
      asResponse: true,
    })
    const normalVE = sentEmails.find((e) => e.to === normalEmail)!
    await auth.api.verifyEmail({ query: { token: extractToken(normalVE.url) }, asResponse: true })

    // Sign in both
    const adminSignIn = await auth.api.signInEmail({ body: { email: adminEmail, password }, asResponse: true })
    expect(adminSignIn.status).toBe(200)
    const adminCookie = extractCookie(adminSignIn)

    const normalSignIn = await auth.api.signInEmail({ body: { email: normalEmail, password }, asResponse: true })
    expect(normalSignIn.status).toBe(200)
    const normalCookie = extractCookie(normalSignIn)

    // Non-admin should be rejected (403 or thrown)
    const nonAdminRes = await auth.api.listUsers({
      query: {},
      headers: cookieHeaders(normalCookie),
      asResponse: true,
    })
    expect(nonAdminRes.status).toBeGreaterThanOrEqual(400)

    // Admin should succeed
    const adminRes = await auth.api.listUsers({
      query: {},
      headers: cookieHeaders(adminCookie),
      asResponse: true,
    })
    expect(adminRes.status).toBe(200)
    const adminData = (await adminRes.json()) as { users: unknown[]; total: number }
    expect(Array.isArray(adminData.users)).toBe(true)
    expect(adminData.users.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Intent 3: ban/unban
// ---------------------------------------------------------------------------
describe('3. ban/unban: ban blocks sign-in; unban restores it', () => {
  test('banUser → banned truthy; sign-in rejected; unbanUser → sign-in works', async () => {
    const db = createDb(env.DB)
    const adminEmail = `ban-admin-${crypto.randomUUID().slice(0, 8)}@test.com`
    const targetEmail = `ban-target-${crypto.randomUUID().slice(0, 8)}@example.com`
    const { auth, sentEmails } = createTestAuth(db, adminEmail)
    const password = 'Password123!'

    // Register admin
    await auth.api.signUpEmail({ body: { email: adminEmail, password, name: 'Ban Admin' }, asResponse: true })
    const adminVE = sentEmails.find((e) => e.to === adminEmail)!
    await auth.api.verifyEmail({ query: { token: extractToken(adminVE.url) }, asResponse: true })

    // Register target
    await auth.api.signUpEmail({ body: { email: targetEmail, password, name: 'Ban Target' }, asResponse: true })
    const targetVE = sentEmails.find((e) => e.to === targetEmail)!
    await auth.api.verifyEmail({ query: { token: extractToken(targetVE.url) }, asResponse: true })

    // Sign in admin
    const adminSignIn = await auth.api.signInEmail({ body: { email: adminEmail, password }, asResponse: true })
    expect(adminSignIn.status).toBe(200)
    const adminCookie = extractCookie(adminSignIn)

    // Get target user id from DB
    const targetRows = await db.select().from(userTable).where(eq(userTable.email, targetEmail))
    expect(targetRows).toHaveLength(1)
    const targetUserId = targetRows[0].id

    // Ban target
    const banRes = await auth.api.banUser({
      body: { userId: targetUserId, banReason: 'Test ban' },
      headers: cookieHeaders(adminCookie),
      asResponse: true,
    })
    expect(banRes.status).toBe(200)

    // Verify banned in DB
    const bannedRows = await db.select().from(userTable).where(eq(userTable.id, targetUserId))
    expect(bannedRows[0].banned).toBe(true)

    // Banned user sign-in should be rejected
    const bannedSignIn = await auth.api.signInEmail({
      body: { email: targetEmail, password },
      asResponse: true,
    })
    expect(bannedSignIn.status).toBeGreaterThanOrEqual(400)

    // Unban target
    const unbanRes = await auth.api.unbanUser({
      body: { userId: targetUserId },
      headers: cookieHeaders(adminCookie),
      asResponse: true,
    })
    expect(unbanRes.status).toBe(200)

    // Verify unbanned in DB
    const unbannedRows = await db.select().from(userTable).where(eq(userTable.id, targetUserId))
    expect(unbannedRows[0].banned).toBeFalsy()

    // Sign-in should work again
    const restoredSignIn = await auth.api.signInEmail({
      body: { email: targetEmail, password },
      asResponse: true,
    })
    expect(restoredSignIn.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Intent 4: impersonate / stop impersonating
// ---------------------------------------------------------------------------
describe('4. impersonation: impersonateUser sets impersonatedBy; stopImpersonating clears it', () => {
  test('impersonateUser returns session with impersonatedBy = admin id', async () => {
    const db = createDb(env.DB)
    const adminEmail = `imp-admin-${crypto.randomUUID().slice(0, 8)}@test.com`
    const targetEmail = `imp-target-${crypto.randomUUID().slice(0, 8)}@example.com`
    const { auth, sentEmails } = createTestAuth(db, adminEmail)
    const password = 'Password123!'

    // Register admin
    await auth.api.signUpEmail({ body: { email: adminEmail, password, name: 'Imp Admin' }, asResponse: true })
    const adminVE = sentEmails.find((e) => e.to === adminEmail)!
    await auth.api.verifyEmail({ query: { token: extractToken(adminVE.url) }, asResponse: true })

    // Register target
    await auth.api.signUpEmail({ body: { email: targetEmail, password, name: 'Imp Target' }, asResponse: true })
    const targetVE = sentEmails.find((e) => e.to === targetEmail)!
    await auth.api.verifyEmail({ query: { token: extractToken(targetVE.url) }, asResponse: true })

    // Sign in admin
    const adminSignIn = await auth.api.signInEmail({ body: { email: adminEmail, password }, asResponse: true })
    expect(adminSignIn.status).toBe(200)
    const adminCookie = extractCookie(adminSignIn)

    // Get admin + target user ids from DB
    const adminRows = await db.select().from(userTable).where(eq(userTable.email, adminEmail))
    const targetRows = await db.select().from(userTable).where(eq(userTable.email, targetEmail))
    expect(adminRows).toHaveLength(1)
    expect(targetRows).toHaveLength(1)
    const adminUserId = adminRows[0].id
    const targetUserId = targetRows[0].id

    // Impersonate target
    const impersonateRes = await auth.api.impersonateUser({
      body: { userId: targetUserId },
      headers: cookieHeaders(adminCookie),
      asResponse: true,
    })
    expect(impersonateRes.status).toBe(200)

    // The returned session should have impersonatedBy = adminUserId
    const impersonateData = (await impersonateRes.json()) as {
      session: { id: string; userId: string; impersonatedBy?: string }
      user: { id: string }
    }
    expect(impersonateData.session.impersonatedBy).toBe(adminUserId)
    expect(impersonateData.user.id).toBe(targetUserId)

    // Verify in DB: session row has impersonated_by = adminUserId
    const impSessionRows = await db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.id, impersonateData.session.id))
    expect(impSessionRows).toHaveLength(1)
    expect(impSessionRows[0].impersonatedBy).toBe(adminUserId)

    // stopImpersonating — needs BOTH the new impersonation session cookie AND the
    // admin_session cookie that impersonateUser set. Capture all Set-Cookie values.
    const allImpCookies = extractAllCookies(impersonateRes)
    const stopRes = await auth.api.stopImpersonating({
      headers: cookieHeaders(allImpCookies),
      asResponse: true,
    })
    expect(stopRes.status).toBe(200)

    // The impersonation session should be deleted from DB
    const deletedSessionRows = await db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.id, impersonateData.session.id))
    expect(deletedSessionRows).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Intent 5: getAdminStats — seeded data matches counts
// ---------------------------------------------------------------------------
describe('5. getAdminStats: seeded users/sessions/subscriptions match counts', () => {
  test('totalUsers / activeUsers / subscriptions counts match seeded data', async () => {
    const db = createDb(env.DB)
    const now = Date.now()
    const suffix = crypto.randomUUID().slice(0, 8)

    // We cannot predict the exact total count since other tests also create users.
    // Seed our own data and check the counts are at least our expected values.
    // We seed 3 users directly into D1 for stats testing (bypass auth to avoid email flow).
    const d1 = (db as unknown as { $client: D1Database }).$client

    // Insert 3 fresh users
    const userIds = [
      `stats-u1-${suffix}`,
      `stats-u2-${suffix}`,
      `stats-u3-${suffix}`,
    ]
    for (const uid of userIds) {
      await d1
        .prepare(
          `INSERT OR IGNORE INTO "user" ("id","name","email","email_verified","created_at","updated_at","role")
           VALUES (?,?,?,0,?,?,'user')`,
        )
        .bind(uid, uid, `${uid}@stats.test`, now, now)
        .run()
    }

    // Insert 2 unexpired sessions (active users) and 1 expired session
    const futureExpiry = now + 60 * 60 * 1000 // 1 hour from now
    const pastExpiry = now - 60 * 60 * 1000 // 1 hour ago

    await d1
      .prepare(
        `INSERT OR IGNORE INTO "session" ("id","expires_at","token","created_at","updated_at","user_id")
         VALUES (?,?,?,?,?,?)`,
      )
      .bind(`stats-s1-${suffix}`, futureExpiry, `tok-s1-${suffix}`, now, now, userIds[0])
      .run()
    await d1
      .prepare(
        `INSERT OR IGNORE INTO "session" ("id","expires_at","token","created_at","updated_at","user_id")
         VALUES (?,?,?,?,?,?)`,
      )
      .bind(`stats-s2-${suffix}`, futureExpiry, `tok-s2-${suffix}`, now, now, userIds[1])
      .run()
    // Expired session for userIds[2] — should NOT count as active
    await d1
      .prepare(
        `INSERT OR IGNORE INTO "session" ("id","expires_at","token","created_at","updated_at","user_id")
         VALUES (?,?,?,?,?,?)`,
      )
      .bind(`stats-s3-${suffix}`, pastExpiry, `tok-s3-${suffix}`, now, now, userIds[2])
      .run()

    // Insert subscriptions for users
    await d1
      .prepare(
        `INSERT OR IGNORE INTO "subscription" ("id","user_id","provider","customer_id","status","plan","cancel_at_period_end","created_at","updated_at")
         VALUES (?,?,?,?,?,?,0,?,?)`,
      )
      .bind(`stats-sub1-${suffix}`, userIds[0], 'stripe', `cus-${suffix}-1`, 'active', 'pro', now, now)
      .run()
    await d1
      .prepare(
        `INSERT OR IGNORE INTO "subscription" ("id","user_id","provider","customer_id","status","plan","cancel_at_period_end","created_at","updated_at")
         VALUES (?,?,?,?,?,?,0,?,?)`,
      )
      .bind(`stats-sub2-${suffix}`, userIds[1], 'stripe', `cus-${suffix}-2`, 'past_due', 'free', now, now)
      .run()
    await d1
      .prepare(
        `INSERT OR IGNORE INTO "subscription" ("id","user_id","provider","customer_id","status","plan","cancel_at_period_end","created_at","updated_at")
         VALUES (?,?,?,?,?,?,0,?,?)`,
      )
      .bind(`stats-sub3-${suffix}`, userIds[2], 'stripe', `cus-${suffix}-3`, 'canceled', 'free', now, now)
      .run()

    const stats = await getAdminStats(db, now)

    // totalUsers: at least our 3 seeded users (other tests may have added more)
    expect(stats.totalUsers).toBeGreaterThanOrEqual(3)

    // activeUsers: at least our 2 users with unexpired sessions
    // (userIds[2] only has an expired session so should NOT contribute)
    expect(stats.activeUsers).toBeGreaterThanOrEqual(2)

    // subscriptions: at least 1 active, 1 past_due, 1 canceled, 1 pro, 2 free (from our seed)
    expect(stats.subscriptions.active).toBeGreaterThanOrEqual(1)
    expect(stats.subscriptions.pastDue).toBeGreaterThanOrEqual(1)
    expect(stats.subscriptions.canceled).toBeGreaterThanOrEqual(1)
    expect(stats.subscriptions.pro).toBeGreaterThanOrEqual(1)
    expect(stats.subscriptions.free).toBeGreaterThanOrEqual(2)
  })
})
