import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { APP_GITHUB_URL, APP_NAME } from '@/lib/brand'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: `${APP_NAME} 文档` },
    links: [{ text: '首页', url: '/' }],
    // 空串时不传这个键——fumadocs 的 `githubUrl` 可选，省略即不渲染 GitHub 图标，
    // 不会留下一个 `href=""` 的死链。
    ...(APP_GITHUB_URL ? { githubUrl: APP_GITHUB_URL } : {}),
  }
}
