// 统一命令表 —— 实现文档 §1.2。
// getCommands() 平级拼接各来源（内置 + 用户/项目 skill + 未来插件 skill），
// 全部收敛成同一种 Command；findCommand() 是两个入口（斜杠 / Skill 工具）的共同内核。
//
// 加载时机：启动解析一次 + memoize（同 settings/ preamble 风格）。显式 resetCommandsCache() 失效。

import { getBuiltinCommands, _setHelpCommandSource } from './builtins'
import { loadSkills } from '../skills/loadSkillsDir'
import { skillToCommand } from '../skills/toCommand'
import type { Command } from './types'

// 插件 skill 来源（S3 注入）。默认空，保持来源归一：插件 skill 与手写 skill 同表。
let _pluginSkillSource: (cwd: string) => Command[] = () => []
/** S3 注入：让插件携带的 skill 汇入同一张表。 */
export function _setPluginSkillSource(fn: (cwd: string) => Command[]) {
  _pluginSkillSource = fn
  resetCommandsCache()
}

let _cache = new Map<string, Command[]>()

/**
 * 返回某 cwd 下的完整命令表。平级拼接，name 撞车 first-wins（内置 > 用户 > 项目 > 插件）。
 */
export function getCommands(cwd: string = process.cwd()): Command[] {
  const cached = _cache.get(cwd)
  if (cached) return cached

  const builtin = getBuiltinCommands()
  const { unconditional } = loadSkills(cwd)
  const userProjectSkills = unconditional.map(skillToCommand)
  const pluginSkills = _pluginSkillSource(cwd)

  // first-wins 去重（按 name）：内置优先，其次用户/项目 skill，最后插件 skill
  const merged: Command[] = []
  const seen = new Set<string>()
  for (const c of [...builtin, ...userProjectSkills, ...pluginSkills]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    merged.push(c)
  }

  _cache.set(cwd, merged)
  return merged
}

/** 共同内核：按 name 精确查找。 */
export function findCommand(name: string, cwd: string = process.cwd()): Command | undefined {
  const clean = name.startsWith('/') ? name.slice(1) : name
  return getCommands(cwd).find(c => c.name === clean)
}

/** 清缓存：skill 目录变化 / 插件装卸 / 显式 reload 后调用。 */
export function resetCommandsCache(): void {
  _cache = new Map()
}

// /help 需要全表 —— 注入读取器（避免 builtins ↔ registry 循环依赖在模块初始化期触发）。
_setHelpCommandSource(() => getCommands())
