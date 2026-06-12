// Skill 工具 —— 模型入口（路径 B，实现文档 §1.2）。
// 模型从一级菜单挑一个 name → 调本工具 → 共同内核 findCommand() 精确匹配 →
// 命中 prompt 命令读全文（getPrompt）注入对话。
//
// 闸门：只暴露 type:'prompt' 且 modelInvocable 的命令（disable-model-invocation 屏蔽的调不到）。
// 注：allowed-tools/model 在斜杠入口走 per-query 线程化强制；模型入口 v1 仅注入正文
// （mid-query 线程化随权限上下文层后续补，见实现文档 §1.6）。

import { buildTool } from '../Tool.js'
import type { ToolCallResult, ToolContext } from '../Tool.js'
import { findCommand, getCommands } from '../../commands/registry'
import { menuCommands } from '../../commands/menu'
import { isPromptCommand } from '../../commands/types'

export const SkillTool = buildTool({
  name: 'Skill',
  description: `Load and execute a skill from .astraea/skills/.

Skills are operating manuals (SKILL.md). When you invoke one, its full content is
injected as instructions for you to follow. Pick a skill name from the "Available
skills" menu. Use the bare name (e.g. "code-review"), not a path.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Skill name (bare, no path or extension)' },
      args: { type: 'string', description: 'Optional arguments passed to the skill' },
    },
    required: ['skill'],
  },

  async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolCallResult> {
    const name = String(input['skill'] ?? '').trim()
    const args = input['args'] ? String(input['args']) : undefined

    const cmd = findCommand(name)
    if (!cmd || !isPromptCommand(cmd) || !cmd.modelInvocable) {
      const available = menuCommands(getCommands()).map(c => c.name)
      const list = available.length
        ? `Available skills:\n${available.map(s => `  • ${s}`).join('\n')}`
        : 'No skills are currently available (.astraea/skills/ is empty).'
      return { output: `Skill "${name}" not found or not model-invocable.\n${list}`, isError: true }
    }

    const blocks = await cmd.getPrompt(args)
    const text = blocks.map(b => b.text).join('\n')
    return { output: text }
  },
})
