// VigilDeleteTool — 取消定时任务
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'
import { removeTask, readTasks } from '../../utils/vigilTasks.js'

export const VigilDeleteTool = buildTool({
  name: 'VigilDelete',
  description: `Cancel a scheduled vigil task by ID.

When all tasks are deleted, the background daemon will automatically exit.
Use VigilList to find task IDs.`,
  isReadOnly: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Task ID to delete (from VigilList)',
      },
    },
    required: ['id'],
  },

  async call(input, _ctx: ToolContext): Promise<ToolCallResult> {
    const id = input['id'] as string
    const removed = removeTask(id)

    if (!removed) {
      return { output: `No task found with id: ${id}`, isError: true }
    }

    const remaining = readTasks().length

    return {
      output: [
        `Task ${id} deleted.`,
        remaining === 0
          ? 'No tasks remaining. Daemon will exit automatically.'
          : `${remaining} task(s) still scheduled.`,
      ].join('\n'),
    }
  },
})
