// 插件启动期加载 + 吸管注册 —— 实现文档 §1.8。
// 从 installed_plugins.json 取启用记录 → createPluginFromPath（被动卡片）→ 注册两根吸管，
// 让插件 skill / mcpServers 汇入各自子系统（来源归一）。
// 必须在 initMcp() 之前、首次 getCommands() 之前调用。

import { listEnabledInstalled } from './installedManager'
import { createPluginFromPath, type LoadedPlugin } from './pluginLoader'
import { collectPluginSkills } from './loadPluginSkills'
import { collectPluginMcpServers } from './mcpPluginIntegration'
import { _setPluginSkillSource, resetCommandsCache } from '../commands/registry'
import { _setPluginMcpSource } from '../mcp/config'

export interface PluginStatus {
  name: string
  state: 'loaded' | 'failed'
  version?: string
  skillDirs?: number
  error?: string
}

let _loaded: LoadedPlugin[] = []
let _status: PluginStatus[] = []
let _initialized = false

export function initPlugins(): void {
  const records = listEnabledInstalled()
  const loaded: LoadedPlugin[] = []
  const status: PluginStatus[] = []

  for (const r of records) {
    const res = createPluginFromPath(r.installPath, true)
    if ('plugin' in res) {
      loaded.push(res.plugin)
      status.push({ name: r.pluginId, state: 'loaded', version: r.version, skillDirs: res.plugin.skillsDirs.length })
    } else {
      status.push({ name: r.pluginId, state: 'failed', version: r.version, error: res.error })
    }
  }

  _loaded = loaded
  _status = status
  _initialized = true

  // 注册两根吸管（控制反转：子系统拉取，插件被动）。cwd 无关（插件能力不依赖 cwd）。
  _setPluginSkillSource(() => collectPluginSkills(_loaded))
  _setPluginMcpSource(() => collectPluginMcpServers(_loaded))
}

export function getLoadedPlugins(): LoadedPlugin[] { return _loaded }
export function getPluginStatus(): PluginStatus[] { return _status }
export function isPluginsInitialized(): boolean { return _initialized }

/**
 * 热重载（供 /reload-plugins）：重读 installed_plugins.json、重载启用的插件、重注吸管，
 * 并清空命令表缓存 —— user / project / plugin 三来源的 skill 都会在下一轮 getCommands() 重扫，
 * 新加的 skill 无需重启即可在「下一条消息」生效。
 *
 * 不在覆盖范围：插件携带的 MCP server 连接（已连的保持，新增/变更仍需重启 initMcp 才会重连）。
 */
export function reloadPlugins(): PluginStatus[] {
  initPlugins()        // 重读记录 + 重载插件卡 + 重注吸管（其内部 _setPluginSkillSource 已会清缓存）
  resetCommandsCache() // 显式再清一次：不依赖 setter 的副作用，确保 user/project skill 目录也被重扫
  return _status
}
