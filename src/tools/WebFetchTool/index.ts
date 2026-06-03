// WebFetchTool — 带安全校验的 URL 内容抓取工具
// 参考文档: Astraea Development/v1.0/工具系统/网络执行层/WebFetchTool 教学文档.md
//
// 二次 AI 处理（对齐 best-practices applyPromptToMarkdown）：
//   当调用方传入 prompt 时，用小模型从原始 Markdown 中提炼聚焦内容；
//   未传 prompt 时，直接返回截断后的原始 Markdown（供模型自己阅读）。
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'
import TurndownService from 'turndown'
import { querySmallModel } from '../../api/query-model.js'

const FETCH_TIMEOUT_MS = 30_000
const MAX_CONTENT_CHARS = 50_000

// 懒加载单例：Turndown 实例构建有一定开销（15 条规则对象），
// 首次抓取 HTML 时才初始化，之后复用同一实例。
let _turndown: TurndownService | null = null
function getTurndown(): TurndownService {
  return (_turndown ??= new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' }))
}
// ─── URL 安全校验 ────────────────────────────────────────────────────────────

function validateUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: `无效 URL：${raw}` }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URL 不允许包含用户名或密码' }
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, reason: `不支持的协议：${url.protocol}` }
  }
  if (url.hostname.split('.').length < 2) {
    return { ok: false, reason: '不支持访问本地或私有主机' }
  }
  return { ok: true, url }
}
// ─── HTML → Markdown ─────────────────────────────────────────────────────────

function htmlToMarkdown(html: string): string {
  return getTurndown().turndown(html)
}
// ─── 二次 AI 提炼 Prompt（对齐 best-practices makeSecondaryModelPrompt）────────

function makeProcessingPrompt(markdownContent: string, prompt: string): string {
  const truncated =
    markdownContent.length > MAX_CONTENT_CHARS
      ? markdownContent.slice(0, MAX_CONTENT_CHARS) +
        `\n\n[内容已截断，共 ${markdownContent.length} 字符，仅显示前 ${MAX_CONTENT_CHARS} 字符]`
      : markdownContent

  return `以下是网页内容（Markdown 格式）：
---
${truncated}
---

${prompt}

请根据以上网页内容简洁地回答上述问题。只引用网页中实际存在的信息，不要补充训练数据中的内容。引用原文时加引号，保持在 125 字以内。`
}
// ─── 主工具 ──────────────────────────────────────────────────────────────────

export const WebFetchTool = buildTool({
  name: 'WebFetch',
  description: `Fetches a URL, converts HTML to Markdown, then uses a small AI model to extract the answer to your prompt from the page content.

Use after WebSearch to read the full content of specific articles or documentation pages.
When prompt is provided: returns a focused AI-processed summary of the page.
When prompt is omitted: returns raw Markdown for you to read directly.
IMPORTANT: Will fail for pages that require login or authentication.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch (must be http or https)',
      },
      prompt: {
        type: 'string',
        description: 'Optional: what to focus on when extracting content',
      },
    },
    required: ['url'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const raw = input['url'] as string
    const validation = validateUrl(raw)
    if (!validation.ok) {
      return { output: `Error: ${validation.reason}`, isError: true }
    }

    // http → https 自动升级
    const targetUrl = validation.url.protocol === 'http:'
      ? raw.replace('http://', 'https://')
      : raw

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    try {
      const response = await fetch(targetUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Astraea/1.0 (AI Assistant)' },
      })

      if (!response.ok) {
        return {
          output: `Error: HTTP ${response.status} ${response.statusText} — ${targetUrl}`,
          isError: true,
        }
      }

      const contentType = response.headers.get('content-type') ?? ''
      const text = await response.text()

      const rawMarkdown = contentType.includes('text/html') ? htmlToMarkdown(text) : text
      const prompt = input['prompt'] as string | undefined
      const header = `[WebFetch] ${targetUrl}${prompt ? ` — 关注：${prompt}` : ''}\n${'─'.repeat(60)}\n`

      // 有 prompt → 用小模型提炼聚焦内容；无 prompt → 截断原始 Markdown 直接返回
      if (prompt) {
        try {
          const processed = await querySmallModel(makeProcessingPrompt(rawMarkdown, prompt))
          return { output: header + processed }
        } catch {
          // 二次处理失败时降级为截断原始内容
          const truncated =
            rawMarkdown.length > MAX_CONTENT_CHARS
              ? rawMarkdown.slice(0, MAX_CONTENT_CHARS) + `\n\n[内容已截断，共 ${rawMarkdown.length} 字符]`
              : rawMarkdown
          return { output: header + truncated }
        }
      }

      const truncated =
        rawMarkdown.length > MAX_CONTENT_CHARS
          ? rawMarkdown.slice(0, MAX_CONTENT_CHARS) + `\n\n[内容已截断，共 ${rawMarkdown.length} 字符，显示前 ${MAX_CONTENT_CHARS} 字符]`
          : rawMarkdown
      return { output: header + truncated }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `Error fetching ${targetUrl}: ${msg}`, isError: true }
    } finally {
      clearTimeout(timer)
    }
  },
})
