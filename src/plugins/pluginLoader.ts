// 加载一个插件 = 只解析清单 + 记录路径，绝不执行（被动卡片）—— 实现文档 §1.8 / 方法论第 3 步。
// 约定优于配置：自动探测标准 skills/ 目录，清单没声明也认。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { parsePluginManifest, type PluginManifest } from './schemas'
import { PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE } from './directories'

export interface LoadedPlugin {
  name: string
  manifest: PluginManifest
  /** 插件根（含 .astraea-plugin/plugin.json 的目录）。 */
  rootPath: string
  /** 解析出的 skill 目录（绝对路径）：自动探测的 skills/ + 清单声明的额外目录。 */
  skillsDirs: string[]
  enabled: boolean
}

/** 从插件根读 plugin.json，产出被动 LoadedPlugin。失败返回 { error }。 */
export function createPluginFromPath(
  rootPath: string,
  enabled: boolean,
): { plugin: LoadedPlugin } | { error: string } {
  const manifestPath = join(rootPath, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE)
  if (!existsSync(manifestPath)) return { error: `missing ${PLUGIN_MANIFEST_DIR}/${PLUGIN_MANIFEST_FILE} in ${rootPath}` }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    return { error: `invalid plugin.json: ${String(err)}` }
  }
  const parsed = parsePluginManifest(raw)
  if ('error' in parsed) return parsed

  const skillsDirs = resolveSkillsDirs(rootPath, parsed.manifest)
  return { plugin: { name: parsed.manifest.name, manifest: parsed.manifest, rootPath, skillsDirs, enabled } }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

/** 约定（自动 skills/）+ 配置（manifest.skills）合并，去重。 */
function resolveSkillsDirs(rootPath: string, manifest: PluginManifest): string[] {
  const dirs = new Set<string>()
  const standard = join(rootPath, 'skills')
  if (isDir(standard)) dirs.add(standard)
  for (const rel of manifest.skills ?? []) {
    const abs = isAbsolute(rel) ? rel : resolve(rootPath, rel)
    if (isDir(abs)) dirs.add(abs)
  }
  return [...dirs]
}
