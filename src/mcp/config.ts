// MCP 服务器配置加载 / 写入 —— 实现文档 §1.7。
// 三 scope（复用权限三层路径约定）：
//   project → <cwd>/.mcp.json        （顶层 mcpServers，进 Git，团队共享）
//   user    → ~/.astraea/settings.json   （mcpServers 字段，跨项目）
//   local   → <cwd>/.astraea/settings.local.json（mcpServers 字段，本机私有）
// 合并优先级 local > project > user；撞名 / 撞签名先到先得（manual > plugin，plugin 由 S3 注入）。
//
// 文件内单条 server 采用 CC 兼容形态：
//   { "type": "stdio"?, "command": "...", "args": [...], "env": {...} }   // 默认 stdio
//   { "type": "http"|"sse", "url": "...", "headers": {...} }

import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import type { McpServerConfig, McpScope, McpTransport } from './types'
import { mcpServerSignature } from './types'

// ─── 路径 ──────────────────────────────────────────────────────────────────
export function projectMcpPath(cwd: string): string {
  return join(cwd, '.mcp.json')
}
export function userSettingsPath(): string {
  return join(homedir(), '.astraea', 'settings.json')
}
export function localSettingsPath(cwd: string): string {
  return join(cwd, '.astraea', 'settings.local.json')
}

function scopeFile(scope: Exclude<McpScope, 'plugin'>, cwd: string): { path: string; key: 'mcpServers' } {
  switch (scope) {
    case 'project': return { path: projectMcpPath(cwd), key: 'mcpServers' }
    case 'user': return { path: userSettingsPath(), key: 'mcpServers' }
    case 'local': return { path: localSettingsPath(cwd), key: 'mcpServers' }
  }
}

// ─── 解析 ──────────────────────────────────────────────────────────────────
type RawServer = Record<string, unknown>

function readMcpServersFrom(path: string): Record<string, RawServer> {
  if (!existsSync(path)) return {}
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const servers = obj['mcpServers']
    return servers && typeof servers === 'object' ? (servers as Record<string, RawServer>) : {}
  } catch {
    return {}
  }
}

/** 把一条原始 server JSON 规范化成 McpServerConfig（非法返回 null）。 */
export function normalizeServer(name: string, raw: RawServer, scope: McpScope): McpServerConfig | null {
  const type = (typeof raw['type'] === 'string' ? (raw['type'] as string) : 'stdio') as McpTransport
  if (type === 'http' || type === 'sse') {
    const url = typeof raw['url'] === 'string' ? (raw['url'] as string) : ''
    if (!url) return null
    const headers = raw['headers'] && typeof raw['headers'] === 'object'
      ? (raw['headers'] as Record<string, string>) : undefined
    return { name, transport: type, url, headers, scope }
  }
  // stdio
  const command = typeof raw['command'] === 'string' ? (raw['command'] as string) : ''
  if (!command) return null
  const args = Array.isArray(raw['args']) ? (raw['args'] as unknown[]).map(String) : []
  const env = raw['env'] && typeof raw['env'] === 'object'
    ? (raw['env'] as Record<string, string>) : undefined
  return { name, transport: 'stdio', command, args, env, scope }
}

/** 序列化回文件形态（CC 兼容）。 */
function serializeServer(c: McpServerConfig): RawServer {
  if (c.transport === 'stdio') {
    return { type: 'stdio', command: c.command, args: c.args, ...(c.env ? { env: c.env } : {}) }
  }
  return { type: c.transport, url: c.url, ...(c.headers ? { headers: c.headers } : {}) }
}

// ─── 加载（合并 + 去重）──────────────────────────────────────────────────────
/** 插件提供的 server（S3 注入）。manual > plugin。 */
let _pluginServerSource: (cwd: string) => McpServerConfig[] = () => []
export function _setPluginMcpSource(fn: (cwd: string) => McpServerConfig[]) {
  _pluginServerSource = fn
}

/**
 * 合并三 scope + plugin，返回去重后的最终 server 列表。
 * 顺序：local → project → user → plugin；撞名或撞签名先到先得（manual 全部先于 plugin）。
 */
export function loadMcpServers(cwd: string = process.cwd()): McpServerConfig[] {
  const collect = (scope: Exclude<McpScope, 'plugin'>): McpServerConfig[] => {
    const { path } = scopeFile(scope, cwd)
    const raw = readMcpServersFrom(path)
    return Object.entries(raw)
      .map(([name, r]) => normalizeServer(name, r, scope))
      .filter((c): c is McpServerConfig => c !== null)
  }

  const manual = [...collect('local'), ...collect('project'), ...collect('user')]
  const plugin = _pluginServerSource(cwd)

  const out: McpServerConfig[] = []
  const seenName = new Set<string>()
  const seenSig = new Set<string>()
  for (const c of [...manual, ...plugin]) {
    const sig = mcpServerSignature(c)
    if (seenName.has(c.name) || seenSig.has(sig)) continue
    seenName.add(c.name)
    seenSig.add(sig)
    out.push(c)
  }
  return out
}

// ─── 写入 ──────────────────────────────────────────────────────────────────
function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 写入一条 server 到指定 scope。撞名报错（与 CC 一致）。 */
export function addMcpServer(config: McpServerConfig, cwd: string = process.cwd()): void {
  if (config.scope === 'plugin') throw new Error('cannot write plugin-scope MCP server')
  const { path, key } = scopeFile(config.scope, cwd)
  const obj = readJson(path)
  const servers = (obj[key] && typeof obj[key] === 'object' ? obj[key] : {}) as Record<string, unknown>
  if (servers[config.name]) {
    throw new Error(`MCP server "${config.name}" already exists in ${path}`)
  }
  servers[config.name] = serializeServer(config)
  obj[key] = servers
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (dir) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n')
}

/** 删除一条 server（遍历三 scope，删到第一个匹配）。返回是否删除。 */
export function removeMcpServer(name: string, cwd: string = process.cwd()): boolean {
  for (const scope of ['local', 'project', 'user'] as const) {
    const { path, key } = scopeFile(scope, cwd)
    const obj = readJson(path)
    const servers = (obj[key] && typeof obj[key] === 'object' ? obj[key] : {}) as Record<string, unknown>
    if (servers[name]) {
      delete servers[name]
      obj[key] = servers
      writeFileSync(path, JSON.stringify(obj, null, 2) + '\n')
      return true
    }
  }
  return false
}
