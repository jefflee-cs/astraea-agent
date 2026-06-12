// 物化（materialize）—— 实现文档 §1.8 / 方法论第 6 步。
// 先临时、后原子改名：下载/复制到临时目录 → 读清单定 name/version → 原子 rename 到
// cache/<市场>/<插件>/<版本>/。中途失败只删临时，真 cache 永不出现半成品。
// v1 source = 本地目录，"下载" = copyDir。

import { existsSync, mkdtempSync, mkdirSync, cpSync, rmSync, renameSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { cacheRoot, pluginCacheDir, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE } from './directories'
import { parsePluginManifest, type PluginManifest } from './schemas'

export interface MaterializeResult {
  installPath: string
  manifest: PluginManifest
  version: string
}

/**
 * 把一个本地插件源目录物化进 cache（钉死版本）。
 * @param pluginSrcDir 插件源目录（含 .astraea-plugin/plugin.json）
 * @param marketplace 归属市场名（cache 路径分段）
 */
export function materialize(pluginSrcDir: string, marketplace: string): MaterializeResult {
  if (!existsSync(pluginSrcDir)) throw new Error(`plugin source not found: ${pluginSrcDir}`)

  mkdirSync(cacheRoot(), { recursive: true })
  // 临时目录与最终目录同在 cacheRoot 下 → 同一文件系统 → rename 原子
  const tmp = mkdtempSync(join(cacheRoot(), 'temp_'))
  try {
    cpSync(pluginSrcDir, tmp, { recursive: true })

    // 现在才知道 name/version（清单在源里）
    const manifestPath = join(tmp, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE)
    if (!existsSync(manifestPath)) throw new Error(`materialized plugin missing ${PLUGIN_MANIFEST_DIR}/${PLUGIN_MANIFEST_FILE}`)
    const parsed = parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
    if ('error' in parsed) throw new Error(`invalid plugin.json: ${parsed.error}`)

    const version = parsed.manifest.version ?? '0.0.0'
    const dest = pluginCacheDir(marketplace, parsed.manifest.name, version)

    // 同版本重装：先清干净，再原子搬入
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    renameSync(tmp, dest)  // ← 原子提交

    return { installPath: dest, manifest: parsed.manifest, version }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })  // 失败：只删临时，真 cache 没动
    throw err
  }
}
