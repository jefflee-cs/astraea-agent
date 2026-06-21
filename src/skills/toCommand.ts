// LoadedSkill → PromptCommand —— 实现文档 §1.2/§1.3。
// 来源归一：user / project / plugin 三来源都经此产出同一种 PromptCommand。

import { readFileSync } from 'node:fs'
import { parseSkillFrontmatter } from './frontmatter'
import type { LoadedSkill } from './types'
import type { PromptCommand } from '../commands/types'
import type { TextBlock } from '../types/message'

export function skillToCommand(skill: LoadedSkill): PromptCommand {
  const fm = skill.frontmatter
  return {
    type: 'prompt',
    name: skill.name,
    description: fm.description ?? skill.name,
    source: skill.source,
    userInvocable: fm.userInvocable,
    modelInvocable: fm.modelInvocable,
    argumentHint: fm.argumentHint,
    whenToUse: fm.whenToUse,
    allowedTools: fm.allowedTools,
    model: fm.model,
    paths: fm.paths,
    context: fm.context ?? 'inline',
    agent: fm.agent,
    skillRoot: skill.skillRoot,
    async getPrompt(args: string | undefined): Promise<TextBlock[]> {
      // 命中时才读全文（渐进式披露二级）。重读磁盘 → 反映会内编辑。
      let body: string
      try {
        const content = readFileSync(skill.filePath, 'utf8')
        body = parseSkillFrontmatter(content).body.trim()
      } catch (err) {
        return [{ type: 'text', text: `[skill ${skill.name}] failed to read SKILL.md: ${String(err)}` }]
      }

      // skill 的资源（references/ assets/ scripts/ 等）就在它自己的目录里，而 skill 多是
      // **全局安装**（~/.astraea/skills/<name>），与 cwd 无关——Windows 上甚至可能不同盘符
      // （cwd=E:\proj，skill=C:\Users\…）。若不告知绝对根，模型会把 `references/x.md` 这类
      // 相对路径错按 cwd 解析 → 文件找不到。故：① 展开 <SKILL_ROOT> 占位符为绝对路径；
      // ② 顶部显式声明 skill 目录，要求相对资源按它解析（而非 cwd）。
      const root = skill.skillRoot
      body = body.replace(/\$\{SKILL_ROOT\}|\{\{SKILL_ROOT\}\}|<SKILL_ROOT>|\$SKILL_ROOT/g, root)

      const header = `# Skill: ${skill.name}`
      const locationNote =
        `Skill directory (absolute): ${root}\n` +
        `This skill's bundled files (e.g. references/, assets/, scripts/, templates/) live under that directory. ` +
        `Resolve every relative path in the instructions below against it — NOT the current working directory. ` +
        `When reading or copying those files, use the absolute path under the skill directory.`
      const head = `${header}\n\n${locationNote}`
      const text = args ? `${head}\n\n${body}\n\n---\n**Arguments:** ${args}` : `${head}\n\n${body}`
      return [{ type: 'text', text }]
    },
  }
}
