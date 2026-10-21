import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import mdx from 'fumadocs-mdx/vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

import { GA_CONNECT_HOSTS, GA_SCRIPT_HOSTS } from './src/features/analytics/csp-hosts'

/**
 * Google Analytics 4 measurement id — a BUILD-time value.
 *
 * It is read from the shell/CI environment or a `.env` file (Vite convention),
 * never from `.dev.vars`: a Cloudflare var only exists once the worker is
 * running, which is too late to keep the analytics loader out of the bundle.
 *
 * The id is inlined as a literal, so an empty value is dead code the bundler
 * removes — an unconfigured build ships no GA code at all (see
 * `src/features/analytics/`).
 */
function gaMeasurementId(mode: string): string {
  const env = loadEnv(mode, process.cwd(), 'GA_')
  return (env.GA_MEASUREMENT_ID ?? '').trim()
}

const src = (file: string) => fileURLToPath(new URL(`./src/${file}`, import.meta.url))

export default defineConfig(({ mode }) => {
  const gaId = gaMeasurementId(mode)
  return {
    resolve: {
      tsconfigPaths: true,
      alias: {
        // Without a measurement id the GA loader is replaced by a no-op stub,
        // so the analytics code never even enters the module graph — nothing
        // GA-related ends up in `dist/`. With an id, the real loader is used.
        '@/features/analytics/ga-loader': src(
          gaId ? 'features/analytics/ga-loader.ts' : 'features/analytics/ga-loader.stub.ts',
        ),
      },
    },
    define: {
      // Literal, so `if (!GA_MEASUREMENT_ID)` folds away at build time.
      'import.meta.env.GA_MEASUREMENT_ID': JSON.stringify(gaId),
      // The CSP allow-list for Google — empty when GA4 is not shipped, so an
      // unconfigured build doesn't even carry the hostnames.
      'import.meta.env.GA_SCRIPT_HOSTS': JSON.stringify(gaId ? GA_SCRIPT_HOSTS : []),
      'import.meta.env.GA_CONNECT_HOSTS': JSON.stringify(gaId ? GA_CONNECT_HOSTS : []),
    },
    plugins: [
      mdx(),
      devtools(),
      cloudflare({ viteEnvironment: { name: 'ssr' } }),
      tailwindcss(),
      tanstackStart({
        importProtection: {
          // auth.client.ts is isomorphic (guards window access internally);
          // allow server-side route files to import it.
          server: { excludeFiles: ['**/features/auth/auth.client.*'] },
        },
      }),
      viteReact(),
    ],
  }
})
