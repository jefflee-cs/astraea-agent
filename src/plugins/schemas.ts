// Plugin / Marketplace 清单类型与解析 —— 实现文档 §1.8。
// 手解校验（与 codebase 一致，不引 zod）：parse* 失败返回 { error }。
// manifest 全 8 类字段都收（前向兼容），但 v1 只 wire skills + mcpServers。

// ─── Plugin manifest ─────────────────────────────────────────────────────────
export interface PluginManifest {
  // 元数据
  name: string
  version?: string
  description?: string
  // 贡献物（v1 wire skills + mcpServers；其余 parse-but-ignore）
  skills?: string[]                          // 额外 skill 目录（相对插件根）
  mcpServers?: Record<string, Record<string, unknown>>
  // parse-but-ignore（保留原值，前向兼容）
  commands?: unknown
  agents?: unknown
  hooks?: unknown
  outputStyles?: unknown
  lspServers?: unknown
  channels?: unknown
}

export function parsePluginManifest(raw: unknown): { manifest: PluginManifest } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'manifest is not an object' }
  const o = raw as Record<string, unknown>
  const name = o['name']
  if (typeof name !== 'string' || !name.trim()) return { error: 'manifest.name is required (kebab-case string)' }
  if (/\s/.test(name)) return { error: 'manifest.name must not contain spaces' }

  const manifest: PluginManifest = { name }
  if (typeof o['version'] === 'string') manifest.version = o['version']
  if (typeof o['description'] === 'string') manifest.description = o['description']

  // skills：字符串或字符串数组 → 归一为数组
  if (typeof o['skills'] === 'string') manifest.skills = [o['skills']]
  else if (Array.isArray(o['skills'])) manifest.skills = (o['skills'] as unknown[]).map(String)

  if (o['mcpServers'] && typeof o['mcpServers'] === 'object') {
    manifest.mcpServers = o['mcpServers'] as Record<string, Record<string, unknown>>
  }

  // parse-but-ignore：原样保留
  for (const k of ['commands', 'agents', 'hooks', 'outputStyles', 'lspServers', 'channels'] as const) {
    if (k in o) (manifest as unknown as Record<string, unknown>)[k] = o[k]
  }
  return { manifest }
}

// ─── Marketplace manifest ────────────────────────────────────────────────────
export interface MarketplaceEntry {
  name: string
  /** v1 仅本地 directory source：相对市场根的路径字符串，或 { source:'directory', path }。 */
  source: string | { source: 'directory'; path: string }
  description?: string
}

export interface Marketplace {
  name: string
  plugins: MarketplaceEntry[]
}

export function parseMarketplace(raw: unknown): { marketplace: Marketplace } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'marketplace is not an object' }
  const o = raw as Record<string, unknown>
  const name = o['name']
  if (typeof name !== 'string' || !name.trim()) return { error: 'marketplace.name is required' }
  const pluginsRaw = o['plugins']
  if (!Array.isArray(pluginsRaw)) return { error: 'marketplace.plugins must be an array' }

  const plugins: MarketplaceEntry[] = []
  for (const p of pluginsRaw) {
    if (!p || typeof p !== 'object') continue
    const e = p as Record<string, unknown>
    const pname = e['name']
    if (typeof pname !== 'string' || !pname.trim()) continue
    const src = e['source']
    let source: MarketplaceEntry['source']
    if (typeof src === 'string') source = src
    else if (src && typeof src === 'object' && (src as Record<string, unknown>)['source'] === 'directory') {
      const path = (src as Record<string, unknown>)['path']
      if (typeof path !== 'string') continue
      source = { source: 'directory', path }
    } else {
      // v1 仅支持本地 directory source；其它来源（git/npm/...）跳过并视为未实现
      continue
    }
    plugins.push({
      name: pname,
      source,
      ...(typeof e['description'] === 'string' ? { description: e['description'] as string } : {}),
    })
  }
  return { marketplace: { name, plugins } }
}

/** 解析 entry.source → 相对市场根的子路径（v1 directory source）。 */
export function entrySourceSubpath(source: MarketplaceEntry['source']): string {
  return typeof source === 'string' ? source : source.path
}
