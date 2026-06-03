import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'

let _testDir: string | undefined

/** Test-only: override the skills directory. Pass undefined to restore. */
export function _setSkillsDirForTest(dir: string | undefined) { _testDir = dir }

function skillsDir(): string {
  return _testDir ?? join(resolve('.'), '.claude', 'skills')
}
function listSkillNames(): string[] {
  const dir = skillsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3))
}
function findSkillFile(name: string): string | undefined {
  const base = name.endsWith('.md') ? name.slice(0, -3) : name
  const dir = skillsDir()
  const path = join(dir, `${base}.md`)
  return existsSync(path) ? path : undefined
}
export const SkillTool = buildTool({
  name: 'Skill',
  description: `Load and execute a skill from .claude/skills/.

Skills are Markdown files that contain instructions. When invoked, the skill's
content is injected as the next prompt for the LLM to follow.

Use skill names without the .md extension (e.g. "code-review", not "code-review.md").`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Skill name (with or without .md extension)' },
      args:  { type: 'string', description: 'Optional arguments passed to the skill' },
    },
    required: ['skill'],
  },

  async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolCallResult> {
    const skillName = String(input['skill'] ?? '')
    const args = input['args'] ? String(input['args']) : undefined

    const skillFile = findSkillFile(skillName)
    if (!skillFile) {
      const available = listSkillNames()
      if (available.length === 0) {
        return { output: `没有找到技能"${skillName}"。当前技能目录为空（.claude/skills/）。`, isError: true }
      }
      return {
        output: `没有找到技能"${skillName}"。可用技能：\n${available.map(s => `  • ${s}`).join('\n')}`,
        isError: true,
      }
    }

    const content = readFileSync(skillFile, 'utf8')
    const output = args ? `${content}\n\n---\n**Arguments:** ${args}` : content

    return { output }
  },
})
