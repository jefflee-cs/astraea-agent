// MCP 工具 → 原生 Tool —— 实现文档 §1.7（会话级动态注册表）。
// 每个 server 的工具包成 Astraea Tool，命名 mcp__<server>__<tool>，call → JSON-RPC tools/call。
// query() 循环不感知 MCP；findTool() 能解析这些工具就够了。

import { buildTool } from '../tools/Tool'
import type { Tool, ToolCallResult } from '../tools/Tool'
import type { ConnectedMcpClient } from './transport'

/** 命名空间前缀，避免与内置工具撞名。 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

/** 把一批已连接 server 的工具全部包成原生 Tool。 */
export function mcpToolsToNativeTools(clients: ConnectedMcpClient[]): Tool[] {
  const out: Tool[] = []
  for (const conn of clients) {
    for (const def of conn.tools) {
      const annotations = (def as unknown as { annotations?: { readOnlyHint?: boolean } }).annotations
      const readOnly = annotations?.readOnlyHint === true
      out.push(
        buildTool({
          name: mcpToolName(conn.name, def.name),
          description: def.description || `MCP tool ${def.name} from ${conn.name}`,
          inputSchema: def.inputSchema,
          // 无 readOnlyHint 时保守判写（orbit/counsel 下会被框架层拦截）。
          isReadOnly: () => readOnly,
          isConcurrencySafe: () => readOnly,
          async call(input: Record<string, unknown>): Promise<ToolCallResult> {
            try {
              const res = await conn.client.callTool({ name: def.name, arguments: input })
              return { output: formatMcpResult(res), isError: res.isError === true }
            } catch (err) {
              return { output: `MCP tool error (${conn.name}/${def.name}): ${String(err)}`, isError: true }
            }
          },
        }),
      )
    }
  }
  return out
}

/** 把 callTool 的 content 块拍平成字符串。 */
function formatMcpResult(res: unknown): string {
  const content = (res as { content?: unknown }).content
  if (!Array.isArray(content)) return typeof res === 'string' ? res : JSON.stringify(res)
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; resource?: { text?: string; uri?: string } }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'resource' && b.resource?.text) parts.push(b.resource.text)
    else if (b.type === 'resource' && b.resource?.uri) parts.push(`[resource: ${b.resource.uri}]`)
    else parts.push(JSON.stringify(b))
  }
  return parts.join('\n') || '(empty result)'
}
