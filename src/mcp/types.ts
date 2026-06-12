// MCP 连接类型
// 参考 claude-code-main/src/services/mcp/types.ts

export type MCPTool = {
  name: string
  description: string
}

export type MCPServerConnection =
  | { type: 'pending'; name: string }
  | { type: 'failed'; name: string; error: string }
  | ConnectedMCPServer

export type MCPResource = {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

// ─── 服务器配置（实现文档 §1.7）─────────────────────────────────────────────
// 三传输：stdio（本地子进程）/ http（远程 streamable-http）/ sse（远程）。
// 远程鉴权 v1 仅静态 headers。

export type McpTransport = 'stdio' | 'http' | 'sse'

// 配置 scope（复用权限三层）：local > project > user（撞名先到先得）。
// plugin scope 由 S3 注入（manual > plugin）。
export type McpScope = 'project' | 'user' | 'local' | 'plugin'

export interface McpStdioConfig {
  name: string
  transport: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
  scope: McpScope
}

export interface McpRemoteConfig {
  name: string
  transport: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
  scope: McpScope
}

export type McpServerConfig = McpStdioConfig | McpRemoteConfig

/** 内容签名（实现文档 §1.7）：stdio 按 command+args+env，远程按 url+headers。 */
export function mcpServerSignature(c: McpServerConfig): string {
  if (c.transport === 'stdio') {
    return `stdio:${c.command} ${c.args.join(' ')}|${JSON.stringify(c.env ?? {})}`
  }
  return `${c.transport}:${c.url}|${JSON.stringify(c.headers ?? {})}`
}

export type ConnectedMCPServer = {
  type: 'connected'
  name: string
  instructions?: string
  tools: MCPTool[]
  /** Resources exposed by this MCP server (populated lazily). */
  resources?: MCPResource[]
}
