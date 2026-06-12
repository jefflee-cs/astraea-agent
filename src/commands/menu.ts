// 渐进式披露 —— 一级菜单（实现文档 §1.4）。
// 只列出模型可见的 prompt 命令（skill），每行 `- name: description（whenToUse 拼上）`。
// 预算 = 上下文窗口的 1%（chars ≈ tokens×4），超预算截断每条 description。
// 菜单会话内稳定 → 调用方放可缓存系统提示前缀区。

import type { Command, PromptCommand } from './types'
import { isPromptCommand } from './types'

const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
const CHARS_PER_TOKEN = 4

/** 模型菜单只收 prompt 类、且 modelInvocable 的命令。 */
export function menuCommands(commands: Command[]): PromptCommand[] {
  return commands.filter(
    (c): c is PromptCommand => isPromptCommand(c) && c.modelInvocable,
  )
}

/** 单行：`- name: description - whenToUse`（getCommandDescription 同款拼法）。 */
function lineFor(cmd: PromptCommand, maxDescChars: number): string {
  let desc = cmd.whenToUse ? `${cmd.description} - ${cmd.whenToUse}` : cmd.description
  desc = desc.replace(/\s+/g, ' ').trim()
  if (desc.length > maxDescChars) desc = desc.slice(0, Math.max(0, maxDescChars - 1)).trimEnd() + '…'
  return `- ${cmd.name}: ${desc}`
}

/**
 * 构建注入系统提示的 skill 菜单 section。无可见 skill → 返回 null。
 * @param contextWindowTokens 活动模型上下文窗口（token）
 */
export function buildSkillMenu(commands: Command[], contextWindowTokens: number): string | null {
  const cmds = menuCommands(commands)
  if (cmds.length === 0) return null

  const budgetChars = Math.max(200, Math.floor(contextWindowTokens * SKILL_BUDGET_CONTEXT_PERCENT * CHARS_PER_TOKEN))
  const header = 'Available skills (invoke with the Skill tool when relevant):'
  // 预算在各条间均摊，给每条 description 一个上限，保证总长可控。
  const perLineBudget = Math.max(40, Math.floor((budgetChars - header.length) / cmds.length))
  const maxDescChars = Math.max(20, perLineBudget - 24) // 扣掉 "- name: " 等固定开销

  const lines = cmds.map(c => lineFor(c, maxDescChars))

  // 二次保险：拼完仍超总预算则逐行丢弃尾部
  let body = lines.join('\n')
  if (header.length + 1 + body.length > budgetChars) {
    const kept: string[] = []
    let used = header.length + 1
    for (const l of lines) {
      if (used + l.length + 1 > budgetChars) break
      kept.push(l)
      used += l.length + 1
    }
    body = kept.join('\n')
  }

  return `${header}\n${body}`
}
