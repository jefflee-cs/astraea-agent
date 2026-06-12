// `astraea plugin …` 子命令 —— 实现文档 §1.8 / §1.9。
//   astraea plugin marketplace add <dir> | remove <name> | list
//   astraea plugin install <name>[@marketplace] [--scope user|project|local]
//   astraea plugin uninstall <name>
//   astraea plugin enable|disable <name>
//   astraea plugin list
// 不变量（对齐 CC）：install 只装"货架上的商品"；含 / 的参数当作"加市场"。

import { rmSync } from 'node:fs'
import { addMarketplace, removeMarketplace, listMarketplaces, resolvePluginEntry } from '../plugins/marketplaceManager'
import { materialize } from '../plugins/materialize'
import {
  addInstallRecord, removeInstallRecord, setEnabled, listInstalled, type PluginScope,
} from '../plugins/installedManager'

export async function runPluginCommand(argv: string[]): Promise<void> {
  const sub = argv[0]
  switch (sub) {
    case 'marketplace': case 'mp': return cmdMarketplace(argv.slice(1))
    case 'install': return cmdInstall(argv.slice(1))
    case 'uninstall': case 'remove': case 'rm': return cmdUninstall(argv.slice(1))
    case 'enable': return cmdToggle(argv.slice(1), true)
    case 'disable': return cmdToggle(argv.slice(1), false)
    case 'list': case 'ls': return cmdList()
    default:
      usage(); process.exit(1)
  }
}

function usage(): void {
  console.error('Usage: astraea plugin <marketplace|install|uninstall|enable|disable|list>')
  console.error('  astraea plugin marketplace add <dir> | remove <name> | list')
  console.error('  astraea plugin install <name>[@marketplace] [--scope user|project|local]')
  console.error('  astraea plugin uninstall <name>')
  console.error('  astraea plugin enable|disable <name>')
  console.error('  astraea plugin list')
}

function cmdMarketplace(argv: string[]): void {
  const action = argv[0]
  if (action === 'add') {
    const dir = argv[1]
    if (!dir) { console.error('Usage: astraea plugin marketplace add <dir>'); process.exit(1) }
    const res = addMarketplace(dir)
    if ('error' in res) { console.error(`Error: ${res.error}`); process.exit(1) }
    console.log(`✓ Added marketplace "${res.name}".`)
  } else if (action === 'remove' || action === 'rm') {
    const name = argv[1]
    if (!name) { console.error('Usage: astraea plugin marketplace remove <name>'); process.exit(1) }
    console.log(removeMarketplace(name) ? `✓ Removed marketplace "${name}".` : `Marketplace "${name}" not found.`)
  } else if (action === 'list' || action === 'ls' || action === undefined) {
    const mps = listMarketplaces()
    if (mps.length === 0) { console.log('No marketplaces configured.'); return }
    for (const m of mps) console.log(`  ${m.name}  (${m.pluginCount} plugins)  ${m.source}`)
  } else {
    console.error('Usage: astraea plugin marketplace <add|remove|list>'); process.exit(1)
  }
}

function parseScope(argv: string[]): { scope: PluginScope; rest: string[] } {
  let scope: PluginScope = 'user'
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scope') { scope = (argv[++i] as PluginScope) ?? 'user'; continue }
    rest.push(argv[i]!)
  }
  return { scope, rest }
}

function cmdInstall(argv: string[]): void {
  const { scope, rest } = parseScope(argv)
  const target = rest[0]
  if (!target) { console.error('Usage: astraea plugin install <name>[@marketplace]'); process.exit(1) }

  // 含路径分隔符 → 当作"加市场"（CC 不变量）
  if (target.includes('/') || target.includes('\\')) {
    const res = addMarketplace(target)
    if ('error' in res) { console.error(`Error: ${res.error}`); process.exit(1) }
    console.log(`✓ Added marketplace "${res.name}". Now run: astraea plugin install <plugin-name>`)
    return
  }

  const [name, marketplace] = target.split('@')
  const resolved = resolvePluginEntry(name!, marketplace)
  if ('error' in resolved) { console.error(`Error: ${resolved.error}`); process.exit(1) }

  try {
    const mat = materialize(resolved.pluginDir, resolved.marketplaceName)
    addInstallRecord({
      pluginId: mat.manifest.name,
      marketplace: resolved.marketplaceName,
      version: mat.version,
      installPath: mat.installPath,
      scope,
      enabled: true,
      installedAt: new Date().toISOString(),
    })
    console.log(`✓ Installed "${mat.manifest.name}" v${mat.version} (scope=${scope}) from ${resolved.marketplaceName}.`)
    console.log('  Restart Astraea to load it.')
  } catch (err) {
    console.error(`Error: ${String(err)}`); process.exit(1)
  }
}

function cmdUninstall(argv: string[]): void {
  const name = argv[0]
  if (!name) { console.error('Usage: astraea plugin uninstall <name>'); process.exit(1) }
  const removed = removeInstallRecord(name)
  if (removed.length === 0) { console.log(`Plugin "${name}" not installed.`); return }
  for (const r of removed) {
    try { rmSync(r.installPath, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  console.log(`✓ Uninstalled "${name}" (${removed.length} install record(s) + cache removed).`)
}

function cmdToggle(argv: string[], enabled: boolean): void {
  const name = argv[0]
  if (!name) { console.error(`Usage: astraea plugin ${enabled ? 'enable' : 'disable'} <name>`); process.exit(1) }
  const hit = setEnabled(name, enabled)
  console.log(hit ? `✓ ${enabled ? 'Enabled' : 'Disabled'} "${name}". Restart to apply.` : `Plugin "${name}" not installed.`)
}

function cmdList(): void {
  const records = listInstalled()
  if (records.length === 0) { console.log('No plugins installed.'); return }
  for (const r of records) {
    console.log(`  ${r.enabled ? '✓' : '○'} ${r.pluginId} v${r.version} [${r.scope}] from ${r.marketplace}`)
  }
}
