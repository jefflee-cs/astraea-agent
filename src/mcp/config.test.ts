import { test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeServer, loadMcpServers, addMcpServer, removeMcpServer } from './config'
import { mcpServerSignature } from './types'

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'astraea-mcp-'))
  tmps.push(d)
  return d
}
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }) })

test('normalizeServer: stdio default + http', () => {
  const stdio = normalizeServer('a', { command: 'npx', args: ['x'] }, 'local')
  expect(stdio).toEqual({ name: 'a', transport: 'stdio', command: 'npx', args: ['x'], env: undefined, scope: 'local' })
  const http = normalizeServer('b', { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer z' } }, 'project')
  expect(http).toEqual({ name: 'b', transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer z' }, scope: 'project' })
})

test('normalizeServer: invalid → null', () => {
  expect(normalizeServer('a', { type: 'http' }, 'local')).toBeNull() // no url
  expect(normalizeServer('a', {}, 'local')).toBeNull() // no command
})

test('loadMcpServers: reads project .mcp.json', () => {
  const cwd = tmp()
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
    mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } },
  }))
  const servers = loadMcpServers(cwd)
  expect(servers.map(s => s.name)).toEqual(['sentry'])
  expect(servers[0]!.transport).toBe('http')
})

test('loadMcpServers: local beats project on name collision', () => {
  const cwd = tmp()
  mkdirSync(join(cwd, '.astraea'), { recursive: true })
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
    mcpServers: { dup: { command: 'project-cmd' } },
  }))
  writeFileSync(join(cwd, '.astraea', 'settings.local.json'), JSON.stringify({
    mcpServers: { dup: { command: 'local-cmd' } },
  }))
  const servers = loadMcpServers(cwd)
  const dup = servers.find(s => s.name === 'dup')!
  expect(dup.scope).toBe('local')
  expect((dup as { command: string }).command).toBe('local-cmd')
})

test('addMcpServer → loadMcpServers round-trip + conflict', () => {
  const cwd = tmp()
  addMcpServer({ name: 'sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: 'Bearer t' }, scope: 'project' }, cwd)
  expect(existsSync(join(cwd, '.mcp.json'))).toBe(true)
  const loaded = loadMcpServers(cwd)
  expect(loaded[0]!.name).toBe('sentry')
  // 撞名报错
  expect(() => addMcpServer({ name: 'sentry', transport: 'stdio', command: 'x', args: [], scope: 'project' }, cwd)).toThrow()
})

test('removeMcpServer', () => {
  const cwd = tmp()
  addMcpServer({ name: 'a', transport: 'stdio', command: 'npx', args: ['s'], scope: 'local' }, cwd)
  expect(loadMcpServers(cwd).length).toBe(1)
  expect(removeMcpServer('a', cwd)).toBe(true)
  expect(loadMcpServers(cwd).length).toBe(0)
  expect(removeMcpServer('nope', cwd)).toBe(false)
})

test('signature dedup: same content different name → second dropped', () => {
  const cwd = tmp()
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
    mcpServers: {
      one: { type: 'http', url: 'https://x/mcp' },
      two: { type: 'http', url: 'https://x/mcp' },
    },
  }))
  const servers = loadMcpServers(cwd)
  expect(servers.length).toBe(1)
})

test('mcpServerSignature distinguishes transport/url', () => {
  const a = mcpServerSignature({ name: 'x', transport: 'http', url: 'https://a', scope: 'local' })
  const b = mcpServerSignature({ name: 'y', transport: 'http', url: 'https://b', scope: 'local' })
  expect(a).not.toBe(b)
})
