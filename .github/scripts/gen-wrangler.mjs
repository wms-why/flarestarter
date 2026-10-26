/**
 * CI helper: generate `wrangler.jsonc` (git-ignored) from the committed
 * `wrangler.example.jsonc` template by injecting the real production resource
 * ids. Run in the Deploy workflow before `pnpm build`.
 *
 * Values come from repo Variables (Settings → Secrets and variables → Actions →
 * Variables) — these are identifiers, not secrets:
 *   - CF_PROD_D1_ID   (required)  production D1 database_id
 *   - CF_PROD_KV_ID   (required)  production KV namespace id
 *   - CF_PROD_DOMAIN  (optional)  custom domain, e.g. flarestarter.com
 *   - CF_WORKER_NAME  (optional)  worker name prefix; default `flarestarter`
 *
 * Only the production env block is patched (this workflow deploys production).
 *
 * Why the worker name is a variable: downstream forks must deploy to their OWN
 * worker, and hard-coding `flarestarter-production` here forced a code edit on
 * every sync with upstream. With this, downstream sets one repo Variable.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const { CF_PROD_D1_ID, CF_PROD_KV_ID, CF_PROD_DOMAIN, CF_WORKER_NAME } = process.env

if (!CF_PROD_D1_ID || !CF_PROD_KV_ID) {
  console.error('::error::Set repo Variables CF_PROD_D1_ID and CF_PROD_KV_ID to enable deploy')
  process.exit(1)
}

/** The production worker name. `CF_WORKER_NAME` is a prefix, matching the template's `-production` convention. */
const PROD_WORKER_NAME = `${(CF_WORKER_NAME || '').trim() || 'flarestarter'}-production`

const text = readFileSync('wrangler.example.jsonc', 'utf8')

// Split at the production env block so replacements never touch staging placeholders.
const at = text.indexOf('"production"')
if (at === -1) {
  console.error('::error::wrangler.example.jsonc has no "production" env block')
  process.exit(1)
}
const head = text.slice(0, at)
let prod = text.slice(at)

// The production slice's own `"name"` is the first one after the split (the block
// opens with it). Rewriting it positionally — rather than string-replacing a
// hard-coded `"name": "flarestarter-production",` — keeps this working when the
// template's default name changes, and gives the custom-domain branch a single
// source of truth for the name it has to match.
const NAME_KEY = '"name"'
const nameAt = prod.indexOf(NAME_KEY)
if (nameAt === -1) {
  console.error('::error::production env block has no "name" — cannot set the worker name')
  process.exit(1)
}
const valueStart = prod.indexOf('"', nameAt + NAME_KEY.length)
const valueEnd = prod.indexOf('"', valueStart + 1)
if (valueStart === -1 || valueEnd === -1) {
  console.error('::error::production env block has a malformed "name" value')
  process.exit(1)
}
const currentName = prod.slice(valueStart + 1, valueEnd)
prod = `${prod.slice(0, valueStart + 1)}${PROD_WORKER_NAME}${prod.slice(valueEnd)}`
const prodNameLine = `${NAME_KEY}: "${PROD_WORKER_NAME}",`

// First occurrence within the production slice is production's own placeholder.
prod = prod
  .replace('00000000-0000-0000-0000-000000000000', CF_PROD_D1_ID)
  .replace('00000000000000000000000000000000', CF_PROD_KV_ID)

if (CF_PROD_DOMAIN) {
  if (!prod.includes(prodNameLine)) {
    console.error(`::error::could not locate the production "name" line to attach the custom domain to`)
    process.exit(1)
  }
  prod = prod.replace(
    prodNameLine,
    `${prodNameLine}\n\t\t\t"routes": [{ "pattern": "${CF_PROD_DOMAIN}", "custom_domain": true }],`,
  )
}

writeFileSync('wrangler.jsonc', head + prod)
console.log(
  `Generated wrangler.jsonc for production as "${PROD_WORKER_NAME}"` +
    `${currentName === PROD_WORKER_NAME ? '' : ` (renamed from "${currentName}")`}` +
    `${CF_PROD_DOMAIN ? ` (domain: ${CF_PROD_DOMAIN})` : ''}`,
)
