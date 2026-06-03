// TaskListTool — 列出所有任务的概览（俯瞰视角）

import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'
import { getState } from '../../services/agent-state.js'

export const TaskListTool = buildTool({
  name: 'TaskList',
  description: `List all tasks and agents — both running and completed.

Returns a summary of every task in the session. Use this to:
- Confirm all background agents have finished before synthesizing results
- Get an overview of what work is in progress
- Find taskIds when you don't have them handy

For full details on a specific task, use TaskGet.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      statusFilter: {
        type: 'string',
        enum: ['all', 'running', 'completed', 'failed', 'killed', 'pending', 'in_progress'],
        description: 'Filter by status (default: all).',
      },
    },
    required: [],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const statusFilter = input['statusFilter'] as string | undefined ?? 'all'
    const tasks = Object.values(getState().tasks)

    const filtered = tasks.filter(t => {
      if (statusFilter === 'all') return true
      return t.status === statusFilter
    })

    if (filtered.length === 0) {
      return { output: `No tasks found${statusFilter !== 'all' ? ` with status "${statusFilter}"` : ''}.` }
    }

    const rows = filtered.map(t => {
      if (t.kind === 'agent') {
        return {
          taskId: t.id,
          kind: 'agent',
          description: t.description,
          status: t.status,
          startedAt: t.startedAt.toISOString(),
        }
      }
      return {
        taskId: t.id,
        kind: 'task',
        subject: t.subject,
        status: t.status,
        updatedAt: t.updatedAt.toISOString(),
      }
    })

    return { output: JSON.stringify(rows, null, 2) }
  },
})
