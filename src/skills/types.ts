// Skill 子系统类型 —— 实现文档 §1.3/§1.5。
// 一个 Skill = 一个目录 + 目录里一个必须叫 SKILL.md 的文件。

import type { CommandSource } from '../commands/types'

/** SKILL.md frontmatter 解析后的字段（除 description 外全可选）。 */
export interface SkillFrontmatter {
  /** 唯一常用必填项。 */
  description?: string
  /** 补充触发时机，菜单里拼到 description 后。 */
  whenToUse?: string
  /** 限定该次调用可用工具（累加授权）。 */
  allowedTools?: string[]
  /** 条件激活 glob；非空 → conditional 桶。 */
  paths?: string[]
  /** 该次调用模型覆盖。 */
  model?: string
  /** 能否被用户 /name 敲出。默认 true。 */
  userInvocable: boolean
  /** 能否被模型经 Skill 工具自主调。默认 true。 */
  modelInvocable: boolean
  /** slash 参数提示。 */
  argumentHint?: string
  /** 执行上下文（v1：inline 生效，fork parse-but-ignore）。 */
  context?: 'inline' | 'fork'
  /** 绑定子代理（v1 parse-but-ignore）。 */
  agent?: string
}

/** 扫描磁盘得到的一个 skill（尚未转成 Command）。 */
export interface LoadedSkill {
  /** 技能名 = 目录名。 */
  name: string
  /** SKILL.md 绝对路径。 */
  filePath: string
  /** 技能根目录（= filePath 的 dirname），用于 fork/hooks 的资源定位。 */
  skillRoot: string
  /** 去重身份：realpath(filePath)。 */
  realPath: string
  /** 来源标签。 */
  source: CommandSource
  /** 解析出的 frontmatter。 */
  frontmatter: SkillFrontmatter
}
