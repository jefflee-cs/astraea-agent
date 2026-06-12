// 已装插件账本 installed_plugins.json —— 实现文档 §1.8（状态分离）。
// V2 形态：pluginId → InstallRecord[]（支持同插件多 scope / 多版本并存）。
// 文件（cache）与启用态（enabled 布尔）是两份独立状态：
//   install → 物化 + 写记录 + enabled:true   uninstall → 删记录（cache 由调用方删）
//   enable/disable → 只翻 enabled 布尔，不碰文件

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { installedPluginsPath } from './directories'

export type PluginScope = 'user' | 'project' | 'local'

export interface InstallRecord {
  pluginId: string         // 插件名（唯一键）
  marketplace: string
  version: string
  installPath: string      // cache/<市场>/<插件>/<版本>/
  scope: PluginScope
  enabled: boolean
  installedAt: string
}

type Ledger = Record<string, InstallRecord[]>

export function readInstalled(): Ledger {
  const path = installedPluginsPath()
  if (!existsSync(path)) return {}
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return obj && typeof obj === 'object' ? (obj as Ledger) : {}
  } catch {
    return {}
  }
}

function writeInstalled(ledger: Ledger): void {
  const path = installedPluginsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(ledger, null, 2) + '\n')
}

/** 全部安装记录拍平。 */
export function listInstalled(): InstallRecord[] {
  return Object.values(readInstalled()).flat()
}

/** 启用中的安装记录（加载时只取这些）。 */
export function listEnabledInstalled(): InstallRecord[] {
  return listInstalled().filter(r => r.enabled)
}

/** 写一条安装记录（同 pluginId+scope 覆盖：重装/换版本）。 */
export function addInstallRecord(record: InstallRecord): void {
  const ledger = readInstalled()
  const arr = (ledger[record.pluginId] ?? []).filter(r => r.scope !== record.scope)
  arr.push(record)
  ledger[record.pluginId] = arr
  writeInstalled(ledger)
}

/** 删除某插件的安装记录（默认全 scope）。返回被删除的记录（供调用方删 cache）。 */
export function removeInstallRecord(pluginId: string, scope?: PluginScope): InstallRecord[] {
  const ledger = readInstalled()
  const arr = ledger[pluginId]
  if (!arr) return []
  const removed = scope ? arr.filter(r => r.scope === scope) : arr
  const keep = scope ? arr.filter(r => r.scope !== scope) : []
  if (keep.length) ledger[pluginId] = keep
  else delete ledger[pluginId]
  writeInstalled(ledger)
  return removed
}

/** 翻转启用布尔（不碰文件）。返回是否有匹配记录。 */
export function setEnabled(pluginId: string, enabled: boolean, scope?: PluginScope): boolean {
  const ledger = readInstalled()
  const arr = ledger[pluginId]
  if (!arr) return false
  let hit = false
  for (const r of arr) {
    if (!scope || r.scope === scope) { r.enabled = enabled; hit = true }
  }
  if (hit) writeInstalled(ledger)
  return hit
}
