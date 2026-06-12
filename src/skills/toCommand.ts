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
      const header = `# Skill: ${skill.name}`
      const text = args ? `${header}\n\n${body}\n\n---\n**Arguments:** ${args}` : `${header}\n\n${body}`
      return [{ type: 'text', text }]
    },
  }
}
