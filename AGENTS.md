# AGENTS.md

Guide for AI coding agents (Claude Code, Codex, etc.) working in this repo.

## What this is

FlareStarter — a Cloudflare-native SaaS starter on **TanStack Start + Cloudflare Workers**, with D1 (SQLite) + KV, Drizzle ORM, better-auth, Stripe, Resend or Flowmails for email, and Tailwind v4. Clone it and build your product on top.

## Structure

- `src/features/*` — vertical feature slices, each self-contained (schema / server fns / actions / components): `admin`, `analytics`, `audience`, `auth`, `billing`, `changelog`, `credits`, `docs`, `email`, `i18n`, `maintenance`, `notifications`, `seo`, `storage`, `theme`, `waitlist`.
- `src/routes/{-$locale}/` — file-based routes with an optional locale prefix (`/` = en, `/zh` = zh). Top-level routes (`api`, `sitemap`, `robots`, `docs`) live outside the locale group.
- `src/components/` — `ui/` primitives + `marketing/` landing + `app/` shell.
- `src/db/` — Drizzle client + `schema.ts` barrel; tables in `src/db/tables/` and feature `*.schema.ts`.
- `src/content/docs/` — in-app docs, grouped into `getting-started/`, `features/`, `platform/`, `customization/` (read `platform/cf-gotchas.mdx` before touching Workers/D1 specifics).

## Conventions

- **Env:** read from `@/lib/env` (re-exports `cloudflare:workers`). Never use `process.env`. In server-only modules read env **lazily** inside the function (`const { env } = await import('@/lib/env')`) so pure cores stay node-testable. Build-time values (e.g. `GA_MEASUREMENT_ID`) are a different thing: they are inlined by Vite via `define` in `vite.config.ts` and read from `.env` / CI env — never from the worker env.
- **Brand is configuration, never a literal.** `src/lib/brand.ts` is the single source (`APP_NAME`, `APP_URL`, `APP_GITHUB_URL`, `APP_LEGAL_NAME`), inlined at build time by `vite.config.ts` the same way `GA_MEASUREMENT_ID` is. Read it from there — never write `'FlareStarter'` in a component, meta tag or server module. Copy strings with a brand in them use the `{app}` placeholder, which `translate()` resolves from `APP_NAME` globally (see `src/features/i18n/locale.ts`); so the dictionary values stay `'{app}'` and only `.env` changes when the product is renamed. Anything reading `APP_GITHUB_URL` **must** guard on emptiness — it is `''` when the operator hides the repo link, and an unguarded consumer renders a dead `href=""`.
- **i18n:** `src/features/i18n/dictionaries/en.ts` + `zh.ts` must be structurally identical (`zh` is typed `Dict = typeof en`). Add every key to both.
- **DB:** Drizzle + D1 migrations — `pnpm db:generate` then `pnpm db:migrate:local`; register new tables in `src/db/schema.ts`.
- **No mock, graceful degradation:** optional integrations (email, Stripe, Turnstile, Sentry) switch off when their env keys are absent — keep that behavior. (Cloudflare Web Analytics needs no key: Cloudflare injects the beacon at the edge.) Google Analytics 4 is the one build-time switch: `GA_MEASUREMENT_ID` is inlined by Vite, and when it is blank `vite.config.ts` aliases the GA loader to a no-op stub so no GA code reaches the bundle.
- **Email providers:** `EMAIL_PROVIDER` picks `resend` (default) or `flowmails`; only that provider's key (`RESEND_API_KEY` / `EMAIL_FLOWMAILS_APIKEY`) is read, and there is no fallback between them. `src/features/email/provider.ts` owns the selection, key lookup and `EMAIL_FROM` parsing — extend it there rather than branching at call sites.
- **Feature switches gate visibility *and* entry points.** `CREDITS_ENABLED` (`src/features/credits/credits-switch.ts`) is the template. If your feature touches credits — or has a switch of its own — it must answer the switch on **both** sides:
  - **Visibility:** every surface it renders (route, nav item, dashboard card, account-page section, admin stat card, i18n label) checks `isCreditsEnabled(env)` / the `creditsEnabled` flag from the root loader and renders **nothing** when off. Client components read the flag from `rootRoute.useLoaderData()`; they must not import `@/lib/env` (it pulls in `cloudflare:workers`).
  - **Entry points:** every credits server fn calls `assertCreditsEnabled(env)` (credits) or gates through `assertCreditsAdmin` (admin) as its **first** statement, *after* auth so a non-admin still gets a 404. Hiding a button is not a boundary — a server fn is a network endpoint and can be called directly, which with the switch off would mint a `credit_account` row and leak ledger data for a feature the operator removed.
  - **Routes** 404 when off (`if (!(await creditsFeatureEnabled())) throw notFound()`), not redirect — a disabled URL should leave no trace.
  - **The data layer is deliberately *not* gated:** webhooks, refunds and the cron backfill still write the ledger with the switch off, so an existing balance is never stranded. Never add a switch check inside `credits.server.ts`.
  - When adding a new credits surface, extend the checklist in the `credits-switch.ts` header comment and add the switch-off case to the tests.
- **Routes:** after adding a route, run `pnpm build` before `pnpm typecheck` (the route tree is generated at build).
- **Tests:** Vitest — node pool (`*.node.test.ts`) for pure logic, workers pool (`*.workers.test.ts`) for D1; the workers pool does NOT auto-apply migrations (hand-create tables in `beforeAll`).

## Commands

```bash
pnpm dev               # vite dev on :3000
pnpm typecheck         # fumadocs-mdx && tsc --noEmit
pnpm test                  # vitest run
pnpm build             # vite build
pnpm db:migrate:local  # apply D1 migrations locally
pnpm deploy:prod       # CLOUDFLARE_ENV=production build + wrangler deploy (staging: deploy:staging)
```

## 本地约定

本模板下游项目自己的约定放这里（或拆到 `AGENTS.local.md`，用 `@AGENTS.local.md` 引入）。
上游内容保持原样，下游只在自己的段落里追加——这样同步上游时 `AGENTS.md` 不会每次冲突。

下游的品牌值不要写进本文档，改 `.env` 的 `APP_*` 即可（见 [品牌与元数据](src/content/docs/customization/branding.mdx)）。
