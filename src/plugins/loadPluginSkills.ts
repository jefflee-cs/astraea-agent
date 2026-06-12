// 吸管①：插件携带的 skill 汇入统一命令表（实现文档 §1.8，来源归一）。
// 插件 skill 与手写 skill 经同一解析器产出同一种 Command，source 标签 'plugin'。
// 注：撞名时 registry 的 first-wins 让内置 > 用户/项目 > 插件（manual > plugin）。

import { loadSkillsFromDir } from '../skills/loadSkillsDir'
import { skillToCommand } from '../skills/toCommand'
import type { Command } from '../commands/types'
import type { LoadedPlugin } from './pluginLoader'

export function collectPluginSkills(plugins: LoadedPlugin[]): Command[] {
  const out: Command[] = []
  const seen = new Set<string>()
  for (const p of plugins) {
    if (!p.enabled) continue
    for (const dir of p.skillsDirs) {
      for (const skill of loadSkillsFromDir(dir, 'plugin')) {
        if (skill.frontmatter.paths && skill.frontmatter.paths.length > 0) continue // conditional 桶 v1 不注入
        if (seen.has(skill.name)) continue
        seen.add(skill.name)
        out.push(skillToCommand(skill))
      }
    }
  }
  return out
}
