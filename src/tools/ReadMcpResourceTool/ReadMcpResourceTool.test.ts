import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { ReadMcpResourceTool, _setMcpFetcherForTest } from './index.js'

type FetchResult = { content: string; mimeType?: string } | { error: string }

let fetcher: (server: string, uri: string) => Promise<FetchResult>

beforeEach(() => {
  fetcher = async (server, uri) => {
    if (server === 'github' && uri === 'repo://owner/repo/README.md') {
      return { content: '# Hello World', mimeType: 'text/markdown' }
    }
    return { error: `Resource not found: ${uri}` }
  }
  _setMcpFetcherForTest(fetcher)
})

afterEach(() => _setMcpFetcherForTest(undefined))

describe('ReadMcpResourceTool — 读取资源', () => {
  test('读取存在的文本资源', async () => {
    const r = await ReadMcpResourceTool.call(
      { server: 'github', uri: 'repo://owner/repo/README.md' },
      { mode: 'default' }
    )
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Hello World')
  })

  test('资源不存在时返回错误', async () => {
    const r = await ReadMcpResourceTool.call(
      { server: 'github', uri: 'repo://owner/repo/MISSING.md' },
      { mode: 'default' }
    )
    expect(r.isError).toBe(true)
    expect(r.output).toContain('MISSING.md')
  })

  test('缺少必填参数时返回错误', async () => {
    const r = await ReadMcpResourceTool.call({ server: 'github' }, { mode: 'default' })
    expect(r.isError).toBe(true)
  })

  test('输出包含 URI 来源标注', async () => {
    const r = await ReadMcpResourceTool.call(
      { server: 'github', uri: 'repo://owner/repo/README.md' },
      { mode: 'default' }
    )
    expect(r.output).toContain('repo://owner/repo/README.md')
  })
})

describe('ReadMcpResourceTool — 元数据', () => {
  test('工具名称正确', () => { expect(ReadMcpResourceTool.name).toBe('ReadMcpResource') })
  test('isReadOnly 为 true', () => { expect(ReadMcpResourceTool.isReadOnly({})).toBe(true) })
})
