// MCP 传输层 —— 实现文档 §1.7。接官方 @modelcontextprotocol/sdk。
//   stdio → 本地子进程     http → StreamableHTTP（远程）   sse → SSE（远程）
// 远程鉴权 v1 仅静态 headers（requestInit.headers）。

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig } from './types'

export interface McpToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

export interface ConnectedMcpClient {
  name: string
  client: Client
  tools: McpToolDef[]
  instructions?: string
  close: () => Promise<void>
}

function buildTransport(config: McpServerConfig): Transport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
    })
  }
  const url = new URL(config.url)
  const opts = config.headers ? { requestInit: { headers: config.headers } } : undefined
  return config.transport === 'http'
    ? new StreamableHTTPClientTransport(url, opts)
    : new SSEClientTransport(url, opts)
}

/** 连接单个 server，拉取工具清单与 instructions。失败抛出（调用方决定容忍）。 */
export async function connectMcpServer(config: McpServerConfig): Promise<ConnectedMcpClient> {
  const client = new Client(
    { name: 'astraea', version: '1.0.0' },
    { capabilities: {} },
  )
  const transport = buildTransport(config)
  await client.connect(transport)

  const instructions = client.getInstructions()
  let tools: McpToolDef[] = []
  try {
    const res = await client.listTools()
    tools = res.tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: normalizeSchema(t.inputSchema as Record<string, unknown> | undefined),
    }))
  } catch {
    tools = []
  }

  return {
    name: config.name,
    client,
    tools,
    instructions: instructions || undefined,
    close: async () => {
      try { await client.close() } catch { /* ignore */ }
    },
  }
}

/** MCP 工具的 inputSchema 兜底成 Astraea ToolSchema 形态。 */
function normalizeSchema(
  s: Record<string, unknown> | undefined,
): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
  const properties = s && typeof s['properties'] === 'object'
    ? (s['properties'] as Record<string, unknown>) : {}
  const required = s && Array.isArray(s['required']) ? (s['required'] as string[]) : undefined
  return { type: 'object', properties, ...(required ? { required } : {}) }
}
