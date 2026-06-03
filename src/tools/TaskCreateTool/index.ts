// TaskCreateTool — 单条任务创建器
// 创建一个可追踪的结构化工作项，返回 taskId 供后续工具引用
// 注意：这里的 Task 是 TaskRecord（进度追踪），不是子 Agent（见 AgentTool）

import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'
import { generateTaskId, setState, getState } from '../../services/agent-state.js'
import type { TaskRecordState } from '../../services/agent-state.js'

export const TaskCreateTool = buildTool({
  name: 'TaskCreate',
  description: `Create a trackable task record to make your work observable to the user.

Use to:
- Declare a complex multi-step piece of work before starting it
- Give the user visibility into what you're doing and its progress
- Enable external systems (hooks) to respond to task lifecycle events

Returns a taskId. Use TaskUpdate to advance its status, TaskGet to query it.
This is different from Agent — TaskCreate is a progress-tracking record, not an AI sub-agent.`,
  isReadOnly: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'Short title for this task (shown in status UI).',
      },
      description: {
        type: 'string',
        description: 'Optional longer description of what this task involves.',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress'],
        description: 'Initial status (default: pending).',
      },
    },
    required: ['subject'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const subject = input['subject'] as string
    const description = input['description'] as string | undefined
    const status = (input['status'] as TaskRecordState['status'] | undefined) ?? 'pending'

    const taskId = generateTaskId()
    const now = new Date()

    const task: TaskRecordState = {
      id: taskId,
      kind: 'task',
      subject,
      description,
      status,
      createdAt: now,
      updatedAt: now,
    }

    setState(prev => ({ ...prev, tasks: { ...prev.tasks, [taskId]: task } }))

    return {
      output: JSON.stringify({
        taskId,
        subject,
        status,
        message: `Task created. Use TaskUpdate("${taskId}", "in_progress") to start it.`,
      }),
    }
  },
})

export function getTaskRecords(): TaskRecordState[] {
  return Object.values(getState().tasks).filter(
    (t): t is TaskRecordState => t.kind === 'task',
  )
}
