// 吸管②：插件携带的 mcpServers 汇入 MCP 配置管线（实现文档 §1.8）。
// manifest.mcpServers 经同一 normalizeServer 产出 McpServerConfig，scope 'plugin'。
// 注：MCP config 层去重 manual > plugin（手写撞签名时插件被跳过）。

import { normalizeServer } from '../mcp/config'
import type { McpServerConfig } from '../mcp/types'
import type { LoadedPlugin } from './pluginLoader'

export function collectPluginMcpServers(plugins: LoadedPlugin[]): McpServerConfig[] {
  const out: McpServerConfig[] = []
  for (const p of plugins) {
    if (!p.enabled || !p.manifest.mcpServers) continue
    for (const [name, raw] of Object.entries(p.manifest.mcpServers)) {
      // 插件内 server 命名加插件前缀，避免跨插件撞名
      const cfg = normalizeServer(`${p.name}:${name}`, raw, 'plugin')
      if (cfg) out.push(cfg)
    }
  }
  return out
}
