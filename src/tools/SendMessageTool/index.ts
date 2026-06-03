// SendMessageTool — 向其他 Agent 或 Claude 进程发送消息
// 支持三种目标：本进程内子 Agent (taskId)、本机其他进程 (uds:...)

import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'
import { pushPendingMessage, getState } from '../../services/agent-state.js'
import { sendToSocket } from '../../services/uds-server.js'

export const SendMessageTool = buildTool({
  name: 'SendMessage',
  description: `Send a message to a sub-agent or another Astraea process.

Supported targets:
  - taskId (e.g. "a3x9m7kp")     → inject message into a running sub-agent's context
  - "uds:/tmp/astraea-<pid>.sock" → send to another Astraea process on this machine

The sub-agent receives the message at its next turn boundary (between tool calls).
Use ListPeers to discover sockets of other Astraea processes.`,
  isReadOnly: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Destination: a taskId (e.g. "a3x9") or "uds:/path/to/socket".',
      },
      message: {
        type: 'string',
        description: 'The message text to send.',
      },
    },
    required: ['to', 'message'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const to = input['to'] as string
    const message = input['message'] as string

    // Local sub-agent: starts with 'a' and exists in AppState
    if (!to.startsWith('uds:') && !to.startsWith('bridge:')) {
      const task = getState().tasks[to]
      if (!task) {
        return { output: `No task or agent found with id "${to}".`, isError: true }
      }
      if (task.kind !== 'agent') {
        return { output: `"${to}" is a task record, not an agent. Cannot send messages to task records.`, isError: true }
      }
      if (task.status !== 'running') {
        return { output: `Agent "${to}" is not running (status: ${task.status}).`, isError: true }
      }
      const sent = pushPendingMessage(to, message)
      return { output: sent ? `Message queued for agent "${to}".` : `Failed to queue message for "${to}".` }
    }

    // UDS: another process on this machine
    if (to.startsWith('uds:')) {
      const socketPath = to.slice(4)
      try {
        await sendToSocket(socketPath, undefined, message)
        return { output: `Message sent to ${socketPath}.` }
      } catch (err) {
        return { output: `Failed to send to ${socketPath}: ${String(err)}`, isError: true }
      }
    }

    // bridge: not implemented in this version
    return {
      output: `"bridge:" protocol is not yet implemented. Use "uds:" for local inter-process messaging.`,
      isError: true,
    }
  },
})
