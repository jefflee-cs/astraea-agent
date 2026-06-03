// TaskGetTool — 查询单个任务的完整状态

import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'
import { getState } from '../../services/agent-state.js'

export const TaskGetTool = buildTool({
  name: 'TaskGet',
  description: `Query the current status and details of a single task or agent by its taskId.

Returns full state including status, result (if completed), error (if failed), and output buffer size.
Use this when you have a specific taskId and want its current state.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The taskId returned by AgentTool or TaskCreateTool.',
      },
    },
    required: ['taskId'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const taskId = input['taskId'] as string
    const task = getState().tasks[taskId]

    if (!task) {
      return { output: `Task "${taskId}" not found.`, isError: true }
    }

    if (task.kind === 'agent') {
      return {
        output: JSON.stringify({
          taskId: task.id,
          kind: 'agent',
          description: task.description,
          status: task.status,
          startedAt: task.startedAt.toISOString(),
          endedAt: task.endedAt?.toISOString(),
          result: task.result,
          error: task.error,
          outputLines: task.outputBuffer.length,
        }),
      }
    }

    return {
      output: JSON.stringify({
        taskId: task.id,
        kind: 'task',
        subject: task.subject,
        description: task.description,
        status: task.status,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
      }),
    }
  },
})
