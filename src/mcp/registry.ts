// 会话级 MCP 动态注册表 —— 实现文档 §1.7。
// 启动时连接全部已配置 server（容忍失败），把发现的工具包成原生 Tool 缓存起来；
// tools/registry.ts 同步追加 getMcpTools()。失败的 server 记录状态供 /mcp 面板展示。

import type { Tool } from '../tools/Tool'
import { loadMcpServers } from './config'
import { connectMcpServer, type ConnectedMcpClient } from './transport'
import { mcpToolsToNativeTools } from './toTools'
import type { McpScope, McpTransport } from './types'

export interface McpStatus {
  name: string
  transport: McpTransport
  scope: McpScope
  state: 'connected' | 'failed'
  toolCount: number
  error?: string
}

let _clients: ConnectedMcpClient[] = []
let _tools: Tool[] = []
let _status: McpStatus[] = []
let _initialized = false

/** 启动期连接全部已配置 server。幂等：重复调用先断开旧连接再重连。 */
export async function initMcp(cwd: string = process.cwd()): Promise<void> {
  await disconnectMcp()
  const configs = loadMcpServers(cwd)
  const status: McpStatus[] = []
  const connected: ConnectedMcpClient[] = []

  await Promise.all(
    configs.map(async cfg => {
      try {
        const conn = await connectMcpServer(cfg)
        connected.push(conn)
        status.push({
          name: cfg.name, transport: cfg.transport, scope: cfg.scope,
          state: 'connected', toolCount: conn.tools.length,
        })
      } catch (err) {
        status.push({
          name: cfg.name, transport: cfg.transport, scope: cfg.scope,
          state: 'failed', toolCount: 0, error: String(err),
        })
      }
    }),
  )

  _clients = connected
  _tools = mcpToolsToNativeTools(connected)
  _status = status
  _initialized = true
}

/** 已连接 MCP 工具（同步读缓存，供 tools/registry 追加）。 */
export function getMcpTools(): Tool[] {
  return _tools
}

/** 连接状态快照（/mcp 面板用）。 */
export function getMcpStatus(): McpStatus[] {
  return _status
}

export function isMcpInitialized(): boolean {
  return _initialized
}

/** server instructions（注入系统提示用，见 mcp/instructions.ts）。 */
export function getMcpInstructionBlocks(): { name: string; instructions: string }[] {
  return _clients
    .filter(c => c.instructions?.trim())
    .map(c => ({ name: c.name, instructions: c.instructions! }))
}

export async function disconnectMcp(): Promise<void> {
  const old = _clients
  _clients = []
  _tools = []
  await Promise.all(old.map(c => c.close()))
}
