import { describe, test, expect } from 'bun:test'
import { WebFetchTool } from './index.js'

describe('WebFetchTool', () => {
  // ─── URL 校验（纯逻辑，无网络） ───────────────────────────────────────────

  test('拒绝无效 URL', async () => {
    const result = await WebFetchTool.call({ url: 'not-a-url' }, { mode: "default" })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('无效 URL')
  })

  test('拒绝含凭证的 URL', async () => {
    const result = await WebFetchTool.call({ url: 'https://user:pass@example.com' }, { mode: "default" })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('用户名或密码')
  })

  test('拒绝非 http/https 协议', async () => {
    const result = await WebFetchTool.call({ url: 'ftp://example.com/file.txt' }, { mode: "default" })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('不支持的协议')
  })

  test('拒绝本地主机名（无点号）', async () => {
    const result = await WebFetchTool.call({ url: 'http://localhost' }, { mode: "default" })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('私有主机')
  })

  // ─── 真实网络请求 ─────────────────────────────────────────────────────────

  test('成功抓取公开页面', async () => {
    const result = await WebFetchTool.call({ url: 'https://example.com' }, { mode: "default" })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('example.com')
    expect(result.output.length).toBeGreaterThan(10)
  }, 15_000)

  test('返回内容包含 URL 标头', async () => {
    const result = await WebFetchTool.call({ url: 'https://example.com', prompt: '提取标题' }, { mode: "default" })
    expect(result.output).toContain('[WebFetch]')
    expect(result.output).toContain('提取标题')
  }, 15_000)

  test('404 页面返回错误', async () => {
    const result = await WebFetchTool.call({ url: 'https://httpstat.us/404' }, { mode: "default" })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('404')
  }, 15_000)

  // ─── 工具元数据 ───────────────────────────────────────────────────────────

  test('工具名称正确', () => {
    expect(WebFetchTool.name).toBe('WebFetch')
  })

  test('isReadOnly 为 true', () => {
    expect(WebFetchTool.isReadOnly({})).toBe(true)
  })

  test('inputSchema 包含必填字段 url', () => {
    expect(WebFetchTool.inputSchema.required).toContain('url')
  })
})
