import { describe, test, expect, beforeEach } from 'bun:test'
import { WebSearchTool, createAdapter, resetAdapter, _setTestAdapter } from './index.js'
import type { WebSearchAdapter, SearchResult, SearchOptions } from './adapters/types.js'

// ─── Mock 适配器（自定义 Adapter 示例） ──────────────────────────────────────

class MockSearchAdapter implements WebSearchAdapter {
  readonly name = 'mock'
  private readonly _results: SearchResult[]

  constructor(results: SearchResult[] = []) {
    this._results = results
  }

  async search(_query: string, options?: SearchOptions): Promise<SearchResult[]> {
    let results = [...this._results]
    if (options?.allowedDomains?.length) {
      results = results.filter(r => options.allowedDomains!.some(d => r.url.includes(d)))
    }
    if (options?.blockedDomains?.length) {
      results = results.filter(r => !options.blockedDomains!.some(d => r.url.includes(d)))
    }
    return results
  }
}

const MOCK_RESULTS: SearchResult[] = [
  { title: 'Python Docs', url: 'https://docs.python.org/asyncio', snippet: 'asyncio 文档' },
  { title: 'Stack Overflow', url: 'https://stackoverflow.com/q/123', snippet: 'SO 回答' },
  { title: 'GitHub Repo', url: 'https://github.com/example/repo', snippet: 'GitHub 仓库' },
]

describe('WebSearchTool', () => {
  beforeEach(() => { resetAdapter(); _setTestAdapter(null) })

  // ─── 输入校验（无网络） ───────────────────────────────────────────────────

  test('拒绝空查询', async () => {
    const result = await WebSearchTool.call({ query: '' }, { mode: 'default' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('2 个字符')
  })

  test('拒绝单字符查询', async () => {
    const result = await WebSearchTool.call({ query: 'a' }, { mode: 'default' })
    expect(result.isError).toBe(true)
  })

  test('拒绝同时使用 allowed_domains 和 blocked_domains', async () => {
    const result = await WebSearchTool.call({
      query: 'python asyncio',
      allowed_domains: ['docs.python.org'],
      blocked_domains: ['stackoverflow.com'],
    }, { mode: 'default' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('不能同时指定')
  })

  // ─── Mock 适配器测试（核心逻辑） ─────────────────────────────────────────

  test('使用 Mock 适配器返回格式化结果', async () => {
    _setTestAdapter(new MockSearchAdapter(MOCK_RESULTS))
    const result = await WebSearchTool.call({ query: 'python asyncio' }, { mode: 'default' })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('[WebSearch]')
    expect(result.output).toContain('Python Docs')
    expect(result.output).toContain('docs.python.org')
  })

  test('allowed_domains 过滤只返回 python.org 结果', async () => {
    _setTestAdapter(new MockSearchAdapter(MOCK_RESULTS))
    const result = await WebSearchTool.call({
      query: 'asyncio',
      allowed_domains: ['docs.python.org'],
    }, { mode: 'default' })
    expect(result.output).toContain('Python Docs')
    expect(result.output).not.toContain('stackoverflow.com')
    expect(result.output).not.toContain('github.com')
  })

  test('blocked_domains 过滤排除 stackoverflow', async () => {
    _setTestAdapter(new MockSearchAdapter(MOCK_RESULTS))
    const result = await WebSearchTool.call({
      query: 'asyncio',
      blocked_domains: ['stackoverflow.com'],
    }, { mode: 'default' })
    expect(result.output).not.toContain('stackoverflow.com')
    expect(result.output).toContain('Python Docs')
  })

  test('无结果时返回提示', async () => {
    _setTestAdapter(new MockSearchAdapter([]))
    const result = await WebSearchTool.call({ query: 'xyzzy404notfound' }, { mode: 'default' })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('[WebSearch]')
    expect(result.output).toContain('未找到')
  })

  test('结果末尾包含引用来源提示', async () => {
    _setTestAdapter(new MockSearchAdapter(MOCK_RESULTS))
    const result = await WebSearchTool.call({ query: 'test' }, { mode: 'default' })
    expect(result.output).toContain('引用来源')
  })

  // ─── 适配器工厂单例验证 ───────────────────────────────────────────────────

  test('同一 key 返回同一适配器实例', () => {
    const a = createAdapter()
    const b = createAdapter()
    expect(a).toBe(b)
  })

  test('resetAdapter 后返回新实例', () => {
    const a = createAdapter()
    resetAdapter()
    const b = createAdapter()
    expect(a).not.toBe(b)
  })

  // ─── 工具元数据 ───────────────────────────────────────────────────────────

  test('工具名称正确', () => {
    expect(WebSearchTool.name).toBe('WebSearch')
  })

  test('isReadOnly 为 true', () => {
    expect(WebSearchTool.isReadOnly({})).toBe(true)
  })

  // ─── 无 API Key 时给出明确的 Setup 指引 ───────────────────────────────────

  test('无任何 API Key 时返回带 setup 指引的错误（而非静默空结果）', async () => {
    // 隔离环境变量，模拟用户未配置任何 Key 的场景
    const saved = {
      brave: process.env.BRAVE_SEARCH_API_KEY,
      tavily: process.env.TAVILY_API_KEY,
      exa: process.env.EXA_API_KEY,
      adapter: process.env.ASTRAEA_SEARCH_ADAPTER,
    }
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.TAVILY_API_KEY
    delete process.env.EXA_API_KEY
    delete process.env.ASTRAEA_SEARCH_ADAPTER
    resetAdapter()

    try {
      const result = await WebSearchTool.call({ query: 'bun javascript runtime' }, { mode: 'default' })
      expect(result.isError).toBe(true)
      expect(result.output).toContain('BRAVE_SEARCH_API_KEY')
      expect(result.output).toContain('TAVILY_API_KEY')
      expect(result.output).toContain('EXA_API_KEY')
    } finally {
      // 恢复环境变量
      if (saved.brave)   process.env.BRAVE_SEARCH_API_KEY  = saved.brave
      if (saved.tavily)  process.env.TAVILY_API_KEY        = saved.tavily
      if (saved.exa)     process.env.EXA_API_KEY           = saved.exa
      if (saved.adapter) process.env.ASTRAEA_SEARCH_ADAPTER = saved.adapter
      resetAdapter()
    }
  })
})

// ─── 自定义 Adapter 用法示例（文档演示） ─────────────────────────────────────

describe('自定义 Adapter 接入示例', () => {
  test('注入自定义 Adapter 后工具使用该 Adapter', async () => {
    // 演示如何接入企业内部搜索引擎或第三方 API
    class CompanyInternalSearch implements WebSearchAdapter {
      readonly name = 'company-internal'
      async search(query: string): Promise<SearchResult[]> {
        // 这里替换为真实的内部 API 调用
        return [{ title: `内部结果: ${query}`, url: 'https://internal.company.com/search', snippet: '内部搜索结果' }]
      }
    }

    const internalAdapter = new CompanyInternalSearch()
    _setTestAdapter(internalAdapter)
    const result = await WebSearchTool.call({ query: 'astraea architecture' }, { mode: 'default' })
    expect(result.output).toContain('内部结果')
    expect(result.output).toContain('internal.company.com')
  })
})
