// TaskUpdateTool — 更新 TaskRecord 的进度状态
// 仅适用于 TaskCreateTool 创建的 task- 记录，不能用于 Agent 任务

import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'
import { getState, setState } from '../../services/agent-state.js'
import type { TaskRecordStatus } from '../../services/agent-state.js'

export const TaskUpdateTool = buildTool({
  name: 'TaskUpdate',
  description: `Update the status of a task record created by TaskCreateTool.

Valid transitions:
  pending → in_progress → completed | failed

Call this to:
- Mark a task as started before beginning work
- Mark a task completed immediately when done (do not batch completions)
- Mark a task failed if it cannot be completed

Note: This tool operates on TaskRecord items (task- prefix), not Agent tasks (a prefix).
Agent task status is updated automatically via their execution lifecycle.`,
  isReadOnly: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The taskId returned by TaskCreateTool (starts with "task-").',
      },
      status: {
        type: 'string',
        enum: ['in_progress', 'completed', 'failed'],
        description: 'New status to set.',
      },
      notes: {
        type: 'string',
        description: 'Optional notes to attach to this status update.',
      },
    },
    required: ['taskId', 'status'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const taskId = input['taskId'] as string
    const status = input['status'] as TaskRecordStatus

    const task = getState().tasks[taskId]
    if (!task) return { output: `Task "${taskId}" not found.`, isError: true }
    if (task.kind !== 'task') {
      return {
        output: `"${taskId}" is an agent task (kind=${task.kind}). Use TaskStop to cancel agents.`,
        isError: true,
      }
    }

    // Guard against backwards transitions from terminal states
    if (task.status === 'completed' || task.status === 'failed') {
      return {
        output: `Task "${taskId}" is already in terminal state "${task.status}". Cannot update.`,
        isError: true,
      }
    }

    setState(prev => {
      const t = prev.tasks[taskId]
      if (!t || t.kind !== 'task') return prev
      return {
        ...prev,
        tasks: { ...prev.tasks, [taskId]: { ...t, status, updatedAt: new Date() } },
      }
    })

    return {
      output: JSON.stringify({ taskId, status, updated: true }),
    }
  },
})
