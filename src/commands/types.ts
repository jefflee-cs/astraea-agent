// 统一命令表 —— 内置命令与 skill 同住一张表，按 name 主键，type 判别命中后行为。
// 参考 claude-code-main/src/types/command.ts（PromptCommand / LocalCommand / LocalJSXCommand）。
//
// 三类型（实现文档 §1.2）：
//   prompt    — skill / prompt 命令：读全文 → 注入对话 → 交 LLM。模型可调（Skill 工具）。
//   local-jsx — 交互面板命令（/mode //vigil /mcp /plugin /login）：派发 typed action tag，
//               由 App reducer 翻转既有面板状态。模型不可调。
//   local     — 本地逻辑命令（/clear //compact /help /model）：跑本地逻辑 → 返回文本。模型不可调。
//
// 两个入口（用户敲斜杠 / 模型调 Skill 工具）都汇到 registry.findCommand(name)。

import type { TextBlock } from '../types/message'

/** 命令来源标签 —— 只是标签，不分叉逻辑（来源归一原则）。 */
export type CommandSource = 'builtin' | 'user' | 'project' | 'plugin'

// local-jsx 命令携带的 typed action tag —— App reducer 据此翻转既有面板 / 执行 App 态操作。
// kind 是稳定动词；args 透传原始参数串。App 不感知 inline JSX，只解释这些 tag（实现文档 §1.2）。
export type CommandActionKind =
  | 'open-mode-panel'
  | 'open-vigil-panel'
  | 'open-mcp-panel'
  | 'open-plugin-panel'
  | 'login-wizard'
  | 'internet-wizard'
  | 'language-wizard'
  | 'resume-picker'
  | 'rewind-picker'
  | 'clear-history'
  | 'compact-now'
  | 'set-goal'
  | 'switch-mode'      // /mode <name> 直接切换
  | 'wechat-run'       // /wechat 立即整理

export interface CommandAction {
  kind: CommandActionKind
  args?: string
}

/** local 命令的执行结果。 */
export type LocalCommandResult =
  | { type: 'text'; value: string }
  | { type: 'skip' }

interface CommandBase {
  name: string
  /** 一行简介 —— 渐进式披露菜单的右半句。 */
  description: string
  source: CommandSource
  /** 能否被用户 /name 敲出（路径 A 闸门）。默认 true。 */
  userInvocable: boolean
  /** 能否被模型经 Skill 工具自主调（路径 B 闸门）。默认仅 prompt 类为 true。 */
  modelInvocable: boolean
  /** slash 选择器里的参数提示，如 "[file]"。 */
  argumentHint?: string
  /** 暂不对外暴露：仍可被 /name 敲出执行，但不进 /help 与 slash 提示。 */
  hidden?: boolean
}

/** prompt 命令（skill 是其主体）：命中读全文注入对话。 */
export interface PromptCommand extends CommandBase {
  type: 'prompt'
  /** 补充触发时机，菜单里拼到 description 后。 */
  whenToUse?: string
  /** 限定该次调用可用工具（累加授权）。 */
  allowedTools?: string[]
  /** 该次调用的模型覆盖。 */
  model?: string
  /** 条件激活 glob；非空者进 conditional 桶，v1 不注入菜单。 */
  paths?: string[]
  /** 执行上下文：inline（默认，展开进当前对话）/ fork（v1 parse-but-ignore）。 */
  context?: 'inline' | 'fork'
  /** 绑定子代理（v1 parse-but-ignore）。 */
  agent?: string
  /** skill 资源根目录（用于 fork / hooks，v1 记录不用）。 */
  skillRoot?: string
  /** 取该命令注入对话的正文（读 SKILL.md 全文 + 拼接 args）。 */
  getPrompt(args: string | undefined): Promise<TextBlock[]>
}

/** local-jsx 命令：派发 action tag 开面板。 */
export interface LocalJsxCommand extends CommandBase {
  type: 'local-jsx'
  /** 命中后交给 App reducer 的 action（可依 args 动态决定）。 */
  toAction(args: string | undefined): CommandAction
}

/** local 命令：跑本地逻辑返回文本。 */
export interface LocalCommand extends CommandBase {
  type: 'local'
  run(args: string | undefined): Promise<LocalCommandResult>
}

export type Command = PromptCommand | LocalJsxCommand | LocalCommand

export function isPromptCommand(c: Command): c is PromptCommand {
  return c.type === 'prompt'
}
