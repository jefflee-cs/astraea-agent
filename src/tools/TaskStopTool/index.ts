// TaskStopTool — 协作式取消运行中的子 Agent
// 通过 AbortController 发送取消信号，子 Agent 自主选择退出时机

import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'
import { killAgentTask, getState } from '../../services/agent-state.js'
import { enqueueAgentNotification } from '../../services/notification-queue.js'

export const TaskStopTool = buildTool({
  name: 'TaskStop',
  description: `Stop a running sub-agent by sending it a cooperative cancellation signal.

The agent receives an AbortSignal and exits at the next safe checkpoint (tool boundary).
This is cooperative cancellation — the agent is not immediately killed.

Use when:
- A background agent is producing unwanted results
- You need to cancel parallel work early
- An agent appears stuck

The agent will emit a <task_notification status="killed"> when it stops.`,
  isReadOnly: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The taskId of the running agent to stop (starts with "a").',
      },
    },
    required: ['taskId'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const taskId = input['taskId'] as string
    const task = getState().tasks[taskId]

    if (!task) return { output: `Task "${taskId}" not found.`, isError: true }
    if (task.kind !== 'agent') {
      return {
        output: `"${taskId}" is a task record, not an agent. Use TaskUpdate to change its status.`,
        isError: true,
      }
    }
    if (task.status !== 'running') {
      return { output: `Agent "${taskId}" is not running (status: ${task.status}).`, isError: true }
    }

    const didKill = killAgentTask(taskId)
    if (didKill) {
      enqueueAgentNotification(taskId, 'killed')
    }

    return { output: `Agent "${taskId}" cancellation signal sent. It will stop at the next safe checkpoint.` }
  },
})
