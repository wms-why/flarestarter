import { createFileRoute } from '@tanstack/react-router'
import { buildManifest } from '@/features/seo/seo'
import { APP_NAME } from '@/lib/brand'

/**
 * Web app manifest, generated instead of served from `public/manifest.json`.
 *
 * 为什么不能是静态文件：`name` / `short_name` 是品牌名，而品牌名是 build-time
 * 值（`src/lib/brand.ts`，由 Vite `define` 内联）——静态文件读不到它。放在
 * `public/` 里就等于把模板名钉死在产物里，指向下游的白牌站会露出上一个产品的名字。
 *
 * 和 robots.txt / sitemap.xml 一样是纯 GET 的 server route；正文由
 * `features/seo/seo.ts` 的 `buildManifest()` 产出（纯函数，node pool 可测）。
 */
const handler = () =>
  new Response(JSON.stringify(buildManifest(APP_NAME)), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      // 品牌名只有在重新构建后才会变，所以可以放心缓存；
      // 但构建产物换了要能尽快生效，1 小时是 manifest 这类文件的常见折中。
      'cache-control': 'public, max-age=3600',
    },
  })

export const Route = createFileRoute('/manifest.webmanifest')({
  server: { handlers: { GET: handler } },
})
