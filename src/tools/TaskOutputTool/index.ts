// TaskOutputTool — 读取子 Agent 的实时输出流（增量 offset 游标）

import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'
import { getState } from '../../services/agent-state.js'

export const TaskOutputTool = buildTool({
  name: 'TaskOutput',
  description: `Read the output buffer of a running or completed sub-agent.

Uses an offset cursor for incremental reads — call repeatedly with increasing offsets
to stream output as the agent produces it.

Returns:
- output: the lines from offset to the latest available
- nextOffset: pass this as offset on your next call
- done: true if the agent has finished and there is no more output

Use to:
- Monitor a background agent's progress in real time
- Detect errors early and decide whether to call TaskStop
- Read the full output of a completed agent`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The taskId of the agent to read output from.',
      },
      offset: {
        type: 'number',
        description: 'Line offset to start reading from (0 = beginning). Use nextOffset from previous call.',
      },
      limit: {
        type: 'number',
        description: 'Max number of lines to return (default: 100).',
      },
    },
    required: ['taskId', 'offset'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const taskId = input['taskId'] as string
    const offset = input['offset'] as number
    const limit = (input['limit'] as number | undefined) ?? 100

    const task = getState().tasks[taskId]
    if (!task) return { output: `Task "${taskId}" not found.`, isError: true }
    if (task.kind !== 'agent') {
      return { output: `"${taskId}" is a task record, not an agent. No output buffer available.`, isError: true }
    }

    const buf = task.outputBuffer
    const slice = buf.slice(offset, offset + limit)
    const nextOffset = Math.min(offset + slice.length, buf.length)
    const done = (task.status !== 'running') && nextOffset >= buf.length

    return {
      output: JSON.stringify({
        output: slice.join('\n'),
        nextOffset,
        done,
        status: task.status,
        totalLines: buf.length,
      }),
    }
  },
})
