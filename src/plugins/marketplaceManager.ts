// 本地 marketplace（货架）管理 —— 实现文档 §1.8。
// v1 仅本地 directory source：市场本体是一个含 .astraea-plugin/marketplace.json 的文件夹；
// 本地无需 clone，直接记录其绝对路径，读 marketplace.json 时实时从该路径读。
//
// known_marketplaces.json：{ [name]: { source: <abs dir>, addedAt } }

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { knownMarketplacesPath, PLUGIN_MANIFEST_DIR, MARKETPLACE_MANIFEST_FILE } from './directories'
import { parseMarketplace, entrySourceSubpath, type Marketplace, type MarketplaceEntry } from './schemas'

interface KnownMarketplace { source: string; addedAt: string }
type KnownLedger = Record<string, KnownMarketplace>

function readKnown(): KnownLedger {
  const path = knownMarketplacesPath()
  if (!existsSync(path)) return {}
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return o && typeof o === 'object' ? (o as KnownLedger) : {}
  } catch { return {} }
}
function writeKnown(l: KnownLedger): void {
  const path = knownMarketplacesPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(l, null, 2) + '\n')
}

/** 读某市场目录的 marketplace.json。 */
export function readMarketplaceAt(dir: string): { marketplace: Marketplace } | { error: string } {
  const manifestPath = join(dir, PLUGIN_MANIFEST_DIR, MARKETPLACE_MANIFEST_FILE)
  if (!existsSync(manifestPath)) return { error: `missing ${PLUGIN_MANIFEST_DIR}/${MARKETPLACE_MANIFEST_FILE} in ${dir}` }
  try {
    return parseMarketplace(JSON.parse(readFileSync(manifestPath, 'utf8')))
  } catch (err) {
    return { error: `invalid marketplace.json: ${String(err)}` }
  }
}

/** 添加一个本地 directory 市场：校验 + 记账。返回市场名或错误。 */
export function addMarketplace(localDir: string): { name: string } | { error: string } {
  const abs = resolve(localDir)
  const parsed = readMarketplaceAt(abs)
  if ('error' in parsed) return parsed
  const ledger = readKnown()
  ledger[parsed.marketplace.name] = { source: abs, addedAt: new Date().toISOString() }
  writeKnown(ledger)
  return { name: parsed.marketplace.name }
}

export function removeMarketplace(name: string): boolean {
  const ledger = readKnown()
  if (!ledger[name]) return false
  delete ledger[name]
  writeKnown(ledger)
  return true
}

export interface MarketplaceInfo { name: string; source: string; pluginCount: number }

/** 列出已订阅市场（含其货单条目数）。 */
export function listMarketplaces(): MarketplaceInfo[] {
  const ledger = readKnown()
  return Object.entries(ledger).map(([name, m]) => {
    const parsed = readMarketplaceAt(m.source)
    return { name, source: m.source, pluginCount: 'marketplace' in parsed ? parsed.marketplace.plugins.length : 0 }
  })
}

export interface ResolvedEntry {
  marketplaceName: string
  marketplaceDir: string
  entry: MarketplaceEntry
  /** 插件源目录绝对路径（market 根 + entry.source 子路径）。 */
  pluginDir: string
}

/**
 * 在已订阅市场里找插件条目（install 内核）。
 * @param pluginName 插件名
 * @param marketplaceName 限定某市场（plugin@marketplace），不传则全市场搜
 */
export function resolvePluginEntry(pluginName: string, marketplaceName?: string): ResolvedEntry | { error: string } {
  const ledger = readKnown()
  const names = marketplaceName ? [marketplaceName] : Object.keys(ledger)
  if (marketplaceName && !ledger[marketplaceName]) {
    return { error: `marketplace "${marketplaceName}" not found. Add it with: astraea plugin marketplace add <dir>` }
  }
  for (const mname of names) {
    const m = ledger[mname]
    if (!m) continue
    const parsed = readMarketplaceAt(m.source)
    if ('error' in parsed) continue
    const entry = parsed.marketplace.plugins.find(p => p.name === pluginName)
    if (entry) {
      return {
        marketplaceName: mname,
        marketplaceDir: m.source,
        entry,
        pluginDir: join(m.source, entrySourceSubpath(entry.source)),
      }
    }
  }
  return { error: `plugin "${pluginName}" not found in any configured marketplace` }
}
