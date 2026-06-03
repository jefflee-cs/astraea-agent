// 简化版 Tool interface
// 参考源码: claude-code-main/src/Tool.ts
//
// 原版依赖 Zod schema + React 渲染 + 权限系统，这里只保留运行所需的最小接口

import type { SessionMode } from '../state/sessionMode'

export interface ToolCallResult {
  output: string
  isError?: boolean
}

// 传给 Anthropic / OpenAI API 的 JSON Schema 格式
export interface ToolSchema {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

// ─── ToolContext ──────────────────────────────────────────────────────────────
// 每次工具调用时由 query.ts 注入的运行时上下文。
//
// 实现新工具时必须：
//   1. call(input, ctx: ToolContext) — 必填，不得省略
//   2. 根据 ctx.mode 决定行为：
//      - 'orbit'   → 写操作工具应返回 deny error
//      - 'forge'   → 跳过所有权限确认，直接执行
//      - 'counsel' → 工具本身无需感知；query.ts 层在用户经 AskUserQuestion 确认方向前，
//                    会按 isReadOnly() 硬拦截所有非只读工具（与 orbit 同机制）
//      - 'default' → 标准流程
//   3. callStream 同样需要接受 ctx 参数
//
// 参考实现：FileEditTool（orbit deny）、BashTool（forge skip confirm）
export interface ToolContext {
  mode: SessionMode
  agentId?: string
  abortSignal?: AbortSignal
  /**
   * 是否有交互式用户在场（可弹出确认框）。判定与阻塞 I/O 解耦的关键信号
   * （Permission & Safety Technical Spec §3.0）：
   *   - true  → 工具遇 ask 可调用 confirmWithUser 弹窗
   *   - false / undefined → 无人在场，遇 ask 一律 fail-closed deny，绝不阻塞挂起
   * sub-agent / cron / background 构造 ctx 时必须置 false。
   * undefined 按 false（fail-closed）处理。
   */
  isInteractive?: boolean
}

export const DEFAULT_TOOL_CONTEXT: ToolContext = { mode: 'default', isInteractive: false }

export interface Tool {
  name: string
  description: string
  inputSchema: ToolSchema['input_schema']
  /** 该工具对该 input 是否只读。用于：(1) 调度层推导 isConcurrencySafe；(2) Astraea orbit 拦截；(3) UI 标签 "Read"/"Edit" */
  isReadOnly(input: Record<string, unknown>): boolean
  /** 该工具对该 input 是否可与其他并发安全工具同时执行。默认 false（fail-closed）。 */
  isConcurrencySafe(input: Record<string, unknown>): boolean
  /** 该工具对该 input 是否执行不可逆操作（删除、覆盖、发送）。默认 false。 */
  isDestructive?(input: Record<string, unknown>): boolean
  call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolCallResult>
  /** Optional per-tool REPL result renderer. Return lines to display; null = use generic fallback. */
  renderResult?(input: Record<string, unknown>, output: string, isError: boolean): string[] | null
  /**
   * Optional streaming execution: yields output chunks as the tool runs,
   * then returns the final ToolCallResult. When present, query.ts uses this
   * instead of call() and emits tool_progress events per chunk.
   */
  callStream?(input: Record<string, unknown>, ctx: ToolContext): AsyncGenerator<string, ToolCallResult>
}

interface ToolDef {
  name: string
  description: string
  inputSchema: ToolSchema['input_schema']
  isReadOnly(input: Record<string, unknown>): boolean
  isConcurrencySafe?(input: Record<string, unknown>): boolean
  isDestructive?(input: Record<string, unknown>): boolean
  call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolCallResult>
  renderResult?(input: Record<string, unknown>, output: string, isError: boolean): string[] | null
  callStream?(input: Record<string, unknown>, ctx: ToolContext): AsyncGenerator<string, ToolCallResult>
}

/** 工厂函数：isReadOnly 必填，其余安全位有保守默认值（fail-closed）。 */
export function buildTool(def: ToolDef): Tool {
  return {
    isConcurrencySafe: () => false,
    isDestructive:     () => false,
    ...def,
  }
}
