import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { ListMcpResourcesTool, _setMcpRegistryForTest } from './index.js'
import type { ConnectedMCPServer } from '../../mcp/types.js'

const fakeServers: ConnectedMCPServer[] = [
  {
    type: 'connected',
    name: 'github',
    tools: [],
    resources: [
      { uri: 'repo://owner/repo/README.md', name: 'README', mimeType: 'text/markdown' },
      { uri: 'repo://owner/repo/src/',      name: '源码目录' },
    ],
  },
  {
    type: 'connected',
    name: 'drive',
    tools: [],
    resources: [
      { uri: 'drive://docs/spec.pdf', name: 'Spec', mimeType: 'application/pdf' },
    ],
  },
]

beforeEach(() => _setMcpRegistryForTest(fakeServers))
afterEach(() => _setMcpRegistryForTest(undefined))

describe('ListMcpResourcesTool — 资源列表', () => {
  test('无 MCP 服务器时返回提示', async () => {
    _setMcpRegistryForTest([])
    const r = await ListMcpResourcesTool.call({}, { mode: 'default' })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('没有')
  })

  test('列出所有服务器的资源', async () => {
    const r = await ListMcpResourcesTool.call({}, { mode: 'default' })
    expect(r.output).toContain('github')
    expect(r.output).toContain('README')
    expect(r.output).toContain('drive')
    expect(r.output).toContain('Spec')
  })

  test('按 server 名称过滤', async () => {
    const r = await ListMcpResourcesTool.call({ server: 'github' }, { mode: 'default' })
    expect(r.output).toContain('README')
    expect(r.output).not.toContain('Spec')
  })

  test('过滤不存在的服务器返回错误', async () => {
    const r = await ListMcpResourcesTool.call({ server: 'nonexistent' }, { mode: 'default' })
    expect(r.isError).toBe(true)
  })

  test('资源无 resources 字段时视为空列表', async () => {
    _setMcpRegistryForTest([{ type: 'connected', name: 'empty', tools: [] }])
    const r = await ListMcpResourcesTool.call({}, { mode: 'default' })
    expect(r.isError).toBeFalsy()
  })
})

describe('ListMcpResourcesTool — 元数据', () => {
  test('工具名称正确', () => { expect(ListMcpResourcesTool.name).toBe('ListMcpResources') })
  test('isReadOnly 为 true', () => { expect(ListMcpResourcesTool.isReadOnly({})).toBe(true) })
})
