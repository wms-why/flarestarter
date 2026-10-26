import { createFileRoute, notFound, getRouteApi } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { Suspense, useEffect } from 'react'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { useTheme } from 'fumadocs-ui/provider/base'
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
} from 'fumadocs-ui/layouts/docs/page'
import { RootProvider } from 'fumadocs-ui/provider/tanstack'
import { useFumadocsLoader } from 'fumadocs-core/source/client'
import { source } from '@/features/docs/source'
import { baseOptions } from '@/features/docs/layout.shared'
import { useMDXComponents } from '@/features/docs/mdx-components'
import browserCollections from 'collections/browser'
import { APP_NAME } from '@/lib/brand'
import docsCss from '@/styles/docs.css?url'

const rootRoute = getRouteApi('__root__')

/**
 * Keep next-themes (which powers the docs theme switch) in sync with the app's
 * cookie-based theme, so toggling in docs is reflected on marketing/app pages
 * (which read the `theme` cookie server-side). The reverse direction is handled
 * in `ThemeToggle`, which also writes next-themes' localStorage key.
 */
function ThemeCookieSync() {
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    if (resolvedTheme !== 'light' && resolvedTheme !== 'dark') return
    // 只在用户做过显式选择时同步：cookie 已存在（站内任意开关选过），或 next-themes 的
    // localStorage 里存了 light/dark（docs 里选过）。无条件写会把"服务端无 cookie 时的
    // 回退值 dark"固化成 cookie，让首访者整站永久锁暗色、废掉 __root 的跟随系统脚本。
    const hasCookie = /(?:^|;\s*)theme=/.test(document.cookie)
    let stored: string | null = null
    try {
      stored = localStorage.getItem('theme')
    } catch {
      // ignore (e.g. storage disabled)
    }
    if (hasCookie || stored === 'light' || stored === 'dark') {
      document.cookie = `theme=${resolvedTheme}; path=/; max-age=31536000`
    }
  }, [resolvedTheme])
  return null
}

const serverLoader = createServerFn({ method: 'GET' })
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs)
    if (!page) throw notFound()
    const { env } = await import('@/lib/env')
    return {
      path: page.path,
      title: page.data.title,
      description: page.data.description,
      origin: new URL(env.BETTER_AUTH_URL).origin,
      pageTree: await source.serializePageTree(source.getPageTree()),
    }
  })

const clientLoader = browserCollections.docs.createClientLoader({
  component({ toc, frontmatter, default: MDX }, props: { markdownUrl: string }) {
    return (
      <DocsPage toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <div className="mb-4 flex">
          <MarkdownCopyButton markdownUrl={props.markdownUrl} />
        </div>
        <DocsBody>
          <MDX components={useMDXComponents()} />
        </DocsBody>
      </DocsPage>
    )
  },
})

export const Route = createFileRoute('/docs/$')({
  loader: async ({ params }) => {
    const slugs = params._splat?.split('/').filter(Boolean) ?? []
    const data = await serverLoader({ data: slugs })
    await clientLoader.preload(data.path)
    return { ...data, docsPath: `/docs/${slugs.join('/')}`.replace(/\/$/, '') || '/docs', markdownUrl: `/docs-md/${slugs.join('/')}` }
  },
  // Per-page title/description — sitemap.xml advertises every docs URL, so each
  // must not fall back to the site-wide default title (duplicate-title farm).
  // og:title/og:description 同步覆盖（否则分享卡片仍显示 __root 的全站默认值，与 <title> 脱节）。
  head: ({ loaderData }) => {
    const title = loaderData?.title ? `${loaderData.title} · ${APP_NAME} Docs` : `${APP_NAME} Docs`
    const canonical = loaderData?.origin ? `${loaderData.origin}${loaderData.docsPath}` : null
    return {
      meta: [
        { title },
        { property: 'og:title', content: title },
        ...(loaderData?.description
          ? [
              { name: 'description', content: loaderData.description },
              { property: 'og:description', content: loaderData.description },
            ]
          : []),
        ...(canonical ? [{ property: 'og:url', content: canonical }] : []),
      ],
      links: [
        { rel: 'stylesheet', href: docsCss },
        ...(canonical ? [{ rel: 'canonical', href: canonical }] : []),
      ],
    }
  },
  component: Page,
})

function Page() {
  const loaderData = Route.useLoaderData()
  // head() 的存在让 loaderData 类型含 undefined；运行时 loader 阻塞渲染，此分支不可达
  if (!loaderData) throw new Error('docs loader data missing')
  const data = useFumadocsLoader(loaderData)
  const { theme, themeFromCookie } = rootRoute.useLoaderData()
  return (
    <RootProvider
      // 有 cookie（显式选择）→ 钉死该主题；没有 → 跟随系统，与 __root 的 boot script 一致，
      // 否则 OS 偏好 light 的首访者会在 docs 被强制成 dark（并闪一下）。
      theme={themeFromCookie ? { defaultTheme: theme, enableSystem: false } : { defaultTheme: 'system' }}
    >
      <ThemeCookieSync />
      <DocsLayout {...baseOptions()} tree={data.pageTree}>
        <Suspense>
          {clientLoader.useContent(data.path, { markdownUrl: loaderData.markdownUrl })}
        </Suspense>
      </DocsLayout>
    </RootProvider>
  )
}
