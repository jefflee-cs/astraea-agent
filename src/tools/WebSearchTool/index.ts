// WebSearchTool — 多适配器搜索工具
// 参考文档: Astraea Development/v1.0/工具系统/网络执行层/WebSearchTool 升级方案.md
//
// 适配器选择（ASTRAEA_SEARCH_ADAPTER 环境变量）：
//   未设置 / "auto" → 自动探测可用 Key（Brave → Tavily → Exa）
//   "brave"         → Brave Search（需要 BRAVE_SEARCH_API_KEY）
//   "tavily"        → Tavily（需要 TAVILY_API_KEY）
//   "exa"           → Exa 语义搜索（需要 EXA_API_KEY）
//   "duckduckgo"    → DuckDuckGo Instant Answer（仅适合百科/定义类查询）
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'
import type { WebSearchAdapter, SearchResult } from './adapters/types.js'
import { DuckDuckGoAdapter } from './adapters/DuckDuckGoAdapter.js'
import { BraveAdapter } from './adapters/BraveAdapter.js'
import { TavilyAdapter } from './adapters/TavilyAdapter.js'
import { ExaAdapter } from './adapters/ExaAdapter.js'

// ─── 自动探测链配置 ──────────────────────────────────────────────────────────

const AUTO_CHAIN: Array<{ key: string; envVar: string; factory: () => WebSearchAdapter }> = [
  { key: 'brave',  envVar: 'BRAVE_SEARCH_API_KEY', factory: () => new BraveAdapter() },
  { key: 'tavily', envVar: 'TAVILY_API_KEY',        factory: () => new TavilyAdapter() },
  { key: 'exa',    envVar: 'EXA_API_KEY',           factory: () => new ExaAdapter() },
]

const NO_KEY_MESSAGE = [
  'WebSearch 需要搜索 API Key。请配置以下任意一个（均有免费额度）：',
  '',
  '  Brave Search（2,000次/月）：',
  '    https://brave.com/search/api/',
  '    export BRAVE_SEARCH_API_KEY=your_key',
  '',
  '  Tavily（1,000次/月，专为 AI Agent 设计）：',
  '    https://tavily.com',
  '    export TAVILY_API_KEY=your_key',
  '',
  '  Exa（1,000次/月，语义搜索）：',
  '    https://exa.ai',
  '    export EXA_API_KEY=your_key',
].join('\n')

class NoApiKeyAdapter implements WebSearchAdapter {
  readonly name = 'none'
  async search(): Promise<SearchResult[]> {
    throw new Error(NO_KEY_MESSAGE)
  }
}
// ─── 适配器工厂（单例缓存） ──────────────────────────────────────────────────

let _adapter: WebSearchAdapter | null = null
let _adapterKey: string | null = null

export function createAdapter(override?: WebSearchAdapter): WebSearchAdapter {
  if (override) return override

  const setting = process.env.ASTRAEA_SEARCH_ADAPTER ?? 'auto'
  const cacheKey = setting + JSON.stringify(
    AUTO_CHAIN.map(c => !!process.env[c.envVar])
  )

  if (_adapter && _adapterKey === cacheKey) return _adapter

  let adapter: WebSearchAdapter

  if (setting === 'auto') {
    // 自动探测：找第一个配置了 API Key 的适配器
    const found = AUTO_CHAIN.find(c => process.env[c.envVar])
    adapter = found ? found.factory() : new NoApiKeyAdapter()
  } else {
    switch (setting) {
      case 'brave':      adapter = new BraveAdapter();      break
      case 'tavily':     adapter = new TavilyAdapter();     break
      case 'exa':        adapter = new ExaAdapter();        break
      case 'duckduckgo': adapter = new DuckDuckGoAdapter(); break
      default:
        throw new Error(
          `未知适配器 "${setting}"。有效值：auto | brave | tavily | exa | duckduckgo`
        )
    }
  }
  _adapter = adapter
  _adapterKey = cacheKey
  return adapter
}
export function resetAdapter(): void {
  _adapter = null
  _adapterKey = null
  _testAdapter = null
}

// 测试专用：注入 mock 适配器（不影响生产代码路径）
let _testAdapter: WebSearchAdapter | null = null
export function _setTestAdapter(adapter: WebSearchAdapter | null): void {
  _testAdapter = adapter
}
// ─── 结果格式化 ──────────────────────────────────────────────────────────────

function formatResults(query: string, results: SearchResult[]): string {
  const lines = [`[WebSearch] 搜索：${query}`, '─'.repeat(60)]

  if (results.length === 0) {
    lines.push('未找到相关结果。')
    return lines.join('\n')
  }
  results.slice(0, 10).forEach((r, i) => {
    lines.push(`${i + 1}. [${r.title}](${r.url})`)
    if (r.snippet) lines.push(`   ${r.snippet}`)
  })
  lines.push(
    '',
    '下一步：如需获取文章详细内容，请对上方关键 URL 依次调用 WebFetch（传入 url 和 prompt 参数）读取全文后再作答。',
    '回答时用 Markdown 超链接格式引用来源。',
  )
  return lines.join('\n')
}
// ─── 主工具 ──────────────────────────────────────────────────────────────────

export const WebSearchTool = buildTool({
  name: 'WebSearch',
  description: `Search the web for current information and return a list of relevant results.

Use when you need up-to-date information that may not be in your training data.
Results include title, URL, and snippet for each match.

Workflow for detailed answers (e.g. news summaries, documentation):
  1. Call WebSearch to discover relevant URLs.
  2. Call WebFetch on the top 2–3 results with a focused prompt to extract full content.
  3. Synthesize a complete answer from the fetched content.

IMPORTANT: Do NOT pass search engines (google.com, bing.com, duckduckgo.com) as allowed_domains — those are search engines, not content sources. Use allowed_domains only for specific content sites (e.g. "docs.python.org", "bbc.com").`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The search query (minimum 2 characters)',
      },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only return results from these domains (cannot combine with blocked_domains)',
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exclude results from these domains (cannot combine with allowed_domains)',
      },
    },
    required: ['query'],
  },

  async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolCallResult> {
    const query = input['query'] as string
    const allowedDomains = input['allowed_domains'] as string[] | undefined
    const blockedDomains = input['blocked_domains'] as string[] | undefined

    if (!query || query.trim().length < 2) {
      return { output: 'Error: 搜索词至少需要 2 个字符', isError: true }
    }
    if (allowedDomains?.length && blockedDomains?.length) {
      return { output: 'Error: 不能同时指定 allowed_domains 和 blocked_domains', isError: true }
    }

    try {
      const adapter = _testAdapter ?? createAdapter()
      const results = await adapter.search(query.trim(), { allowedDomains, blockedDomains })
      return { output: formatResults(query, results) }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `搜索失败：${msg}`, isError: true }
    }
  },
})
