// Plugin 目录布局 —— 实现文档 §1.8。
//   ~/.astraea/plugins/
//   ├── known_marketplaces.json     已订阅的市场账本
//   ├── cache/<市场>/<插件>/<版本>/   钉死版本的已装副本（ASTRAEA_PLUGIN_ROOT）
//   └── installed_plugins.json       已装插件账本（V2 数组）

import { join } from 'node:path'
import { homedir } from 'node:os'

let _rootOverride: string | undefined
/** 测试钩子：覆盖 plugins 根目录。 */
export function _setPluginsRootForTest(dir: string | undefined) { _rootOverride = dir }

export function pluginsRoot(): string {
  // 优先级：测试覆盖 > ASTRAEA_PLUGINS_DIR 环境变量 > ~/.astraea/plugins
  if (_rootOverride) return _rootOverride
  const env = process.env.ASTRAEA_PLUGINS_DIR?.trim()
  return env || join(homedir(), '.astraea', 'plugins')
}
export function knownMarketplacesPath(): string {
  return join(pluginsRoot(), 'known_marketplaces.json')
}
export function installedPluginsPath(): string {
  return join(pluginsRoot(), 'installed_plugins.json')
}
export function cacheRoot(): string {
  return join(pluginsRoot(), 'cache')
}
/** 某插件某版本的钉死安装目录。 */
export function pluginCacheDir(marketplace: string, plugin: string, version: string): string {
  return join(cacheRoot(), marketplace, plugin, version)
}

/** 插件 / 市场清单所在的隐藏子目录名。 */
export const PLUGIN_MANIFEST_DIR = '.astraea-plugin'
export const PLUGIN_MANIFEST_FILE = 'plugin.json'
export const MARKETPLACE_MANIFEST_FILE = 'marketplace.json'
