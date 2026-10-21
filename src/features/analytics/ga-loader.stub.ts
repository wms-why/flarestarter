/**
 * No-op stand-in for `ga-loader.ts`.
 *
 * `vite.config.ts` swaps the real loader for this stub when the build has no
 * `GA_MEASUREMENT_ID`. The stub has the same exports, so the analytics
 * component needs no conditionals — and because the component's guard folds
 * away at build time too, the bundler drops these functions as well. The
 * result: an unconfigured build contains no GA code and never talks to Google.
 *
 * Keep the exported signatures in sync with `ga-loader.ts`.
 */

export function initGa(_measurementId: string): void {}

export function trackPageView(): void {}
