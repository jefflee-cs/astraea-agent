// `astraea mcp …` 子命令 —— 实现文档 §1.7 / §1.9。
//   astraea mcp add [--transport http|sse|stdio] [-e K=V]... [-H "H: V"]... [--scope local|project|user] <name> <cmd-or-url> [-- args...]
//   astraea mcp list
//   astraea mcp remove <name>
// flag 语义对齐 CC：--transport 管本地/远程；-e 设 stdio 环境变量；-H 设远程 header。

import { addMcpServer, removeMcpServer, loadMcpServers } from '../mcp/config'
import type { McpServerConfig, McpTransport, McpScope } from '../mcp/types'

export async function runMcpCommand(argv: string[]): Promise<void> {
  const sub = argv[0]
  switch (sub) {
    case 'add': return cmdAdd(argv.slice(1))
    case 'list': case 'ls': return cmdList()
    case 'remove': case 'rm': return cmdRemove(argv.slice(1))
    default:
      console.error('Usage: astraea mcp <add|list|remove>')
      console.error('  astraea mcp add [--transport http|sse|stdio] [-e K=V] [-H "Header: val"] [--scope local|project|user] <name> <cmd-or-url> [-- args...]')
      console.error('  astraea mcp list')
      console.error('  astraea mcp remove <name>')
      process.exit(1)
  }
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//.test(s) || s.endsWith('/mcp') || s.endsWith('/sse')
}

function cmdAdd(argv: string[]): void {
  let transport: McpTransport | undefined
  let scope: McpScope = 'local'
  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}
  const positionals: string[] = []
  const trailingArgs: string[] = []
  let seenDashDash = false

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    if (seenDashDash) { trailingArgs.push(tok); continue }
    if (tok === '--') { seenDashDash = true; continue }
    if (tok === '--transport' || tok === '-t') { transport = argv[++i] as McpTransport; continue }
    if (tok === '--scope') { scope = argv[++i] as McpScope; continue }
    if (tok === '-e' || tok === '--env') {
      const kv = argv[++i] ?? ''
      const eq = kv.indexOf('=')
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1)
      continue
    }
    if (tok === '-H' || tok === '--header') {
      const h = argv[++i] ?? ''
      const colon = h.indexOf(':')
      if (colon > 0) headers[h.slice(0, colon).trim()] = h.slice(colon + 1).trim()
      continue
    }
    positionals.push(tok)
  }

  const name = positionals[0]
  const target = positionals[1]
  if (!name || !target) {
    console.error('Error: need <name> and <command-or-url>.')
    process.exit(1)
  }

  const t: McpTransport = transport ?? 'stdio'
  let config: McpServerConfig

  if (t === 'http' || t === 'sse') {
    config = { name, transport: t, url: target, ...(Object.keys(headers).length ? { headers } : {}), scope }
  } else {
    // stdio：未显式 --transport 但 target 像 URL → 提醒可能想要 --transport http
    if (!transport && looksLikeUrl(target)) {
      console.error(`Warning: "${target}" looks like a URL but is being treated as a local stdio command. Did you mean --transport http?`)
    }
    const args = [...positionals.slice(2), ...trailingArgs]
    config = { name, transport: 'stdio', command: target, args, ...(Object.keys(env).length ? { env } : {}), scope }
  }

  try {
    addMcpServer(config)
    console.log(`✓ Added MCP server "${name}" (${t}, scope=${scope}).`)
    console.log('  Restart Astraea to connect it.')
  } catch (err) {
    console.error(`Error: ${String(err)}`)
    process.exit(1)
  }
}

function cmdList(): void {
  const servers = loadMcpServers()
  if (servers.length === 0) {
    console.log('No MCP servers configured.')
    return
  }
  for (const s of servers) {
    const detail = s.transport === 'stdio'
      ? `${s.command} ${s.args.join(' ')}`.trim()
      : s.url
    console.log(`  ${s.name}  [${s.transport}, ${s.scope}]  ${detail}`)
  }
}

function cmdRemove(argv: string[]): void {
  const name = argv[0]
  if (!name) { console.error('Usage: astraea mcp remove <name>'); process.exit(1) }
  const removed = removeMcpServer(name)
  console.log(removed ? `✓ Removed MCP server "${name}".` : `MCP server "${name}" not found.`)
}
