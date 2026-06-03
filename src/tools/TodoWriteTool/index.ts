// TodoWriteTool — 会话任务清单管理
// 参考 Claude Code: TodoWriteTool
//
// 规则：
//   - 同时只能有一个 in_progress 任务
//   - allDone=true 时自动清空
//   - 一次性完成 3+ todo 且无验证步骤 → verification nudge
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'
import { getTodos, setTodos, type Todo, type TodoStatus } from '../../services/todo-state.js'

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '◉',
  completed: '✓',
}
export const TodoWriteTool = buildTool({
  name: 'TodoWrite',
  description: `Manage your task checklist for the current session.

Use this tool to:
- Create a structured list of tasks before starting work
- Update task status as you progress (pending → in_progress → completed)
- Track what's done and what remains

Rules:
- Only ONE task can be in_progress at a time
- Mark a task completed IMMEDIATELY after finishing it, not in batches
- Pass the complete list each time (this replaces the current list entirely)

Status values: "pending", "in_progress", "completed"`,
  isReadOnly: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Complete replacement todo list',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique identifier (e.g., "1", "auth-1")' },
            content: { type: 'string', description: 'Task description' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status',
            },
            priority: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'Optional priority',
            },
          },
          required: ['id', 'content', 'status'],
        },
      },
    },
    required: ['todos'],
  },

  async call(input, ctx: ToolContext): Promise<ToolCallResult> {
    const namespace = ctx.agentId ?? 'main'
    const rawTodos = input['todos'] as Array<{
      id: string
      content: string
      status: string
      priority?: string
    }>

    if (!Array.isArray(rawTodos)) {
      return { output: 'todos must be an array', isError: true }
    }

    // ── 验证：同时只能有一个 in_progress ─────────────────────────────────
    const inProgressCount = rawTodos.filter(t => t.status === 'in_progress').length
    if (inProgressCount > 1) {
      return {
        output: `Invalid: ${inProgressCount} tasks marked in_progress. Only 1 allowed at a time.`,
        isError: true,
      }
    }

    const todos: Todo[] = rawTodos.map(t => ({
      id: t.id,
      content: t.content,
      status: t.status as TodoStatus,
      priority: t.priority as Todo['priority'],
    }))

    // ── 写入状态（不自动清空——UI 面板在 1.5s 延迟后负责 clearTodos）────────
    const allDone = todos.length > 0 && todos.every(t => t.status === 'completed')
    setTodos(todos, namespace)

    // ── Verification nudge ────────────────────────────────────────────────
    const prev = getTodos(namespace)
    const prevCompleted = prev.filter(t => t.status === 'completed').length
    const nowCompleted = todos.filter(t => t.status === 'completed').length
    const newlyCompleted = nowCompleted - prevCompleted
    const hasVerifyStep = todos.some(
      t => /verif|test|check|confirm/i.test(t.content)
    )

    let nudge = ''
    if (allDone && todos.length >= 3 && !hasVerifyStep) {
      nudge = '\n\n⚠ All tasks marked complete without a verification step. Consider running tests or confirming output before reporting done.'
    } else if (newlyCompleted >= 3 && !hasVerifyStep) {
      nudge = '\n\n⚠ Multiple tasks completed at once without verification. Have you confirmed the output is correct?'
    }

    return {
      output: `Todo list updated (${todos.length} tasks).${nudge}`,
    }
  },

  renderResult(_input, output, isError) {
    if (isError) return null
    const rawTodos = (_input['todos'] as Array<{ id: string; content: string; status: string; priority?: string }>) ?? []
    if (rawTodos.length === 0) return ['Todo list cleared.']

    const lines = ['Tasks:']
    for (const t of rawTodos) {
      const icon = STATUS_ICON[t.status as TodoStatus] ?? '?'
      const priority = t.priority && t.priority !== 'medium' ? ` [${t.priority}]` : ''
      lines.push(`  ${icon} ${t.content}${priority}`)
    }
    return lines
  },
})
