// AgentTool — 子 Agent 启动器
// Fire-and-Observe 模式：立即返回 taskId，子 Agent 在独立上下文中并行运行

import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'
import { generateAgentId, registerAgentTask } from '../../services/agent-state.js'
import { runSubAgent } from '../../services/run-sub-agent.js'
import { getSessionSystemPrompt } from '../../services/session-context.js'
import { getWorkerTools } from '../registry.js'

export const AgentTool = buildTool({
  name: 'Agent',
  description: `Launch an independent sub-agent with its own context window and tool access.

Use to:
- Parallelize independent sub-tasks (each gets a clean context, no pollution)
- Delegate a focused investigation or transformation to a specialist context
- Run tasks concurrently (call Agent multiple times without awaiting — each returns a taskId)

Returns immediately with a taskId. The sub-agent runs in the background.
When the sub-agent completes, a <task_notification> is injected into your next turn.
Use TaskList / TaskGet to monitor running agents.`,
  isReadOnly: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The full task prompt for the sub-agent. Be specific — the sub-agent has no context from the current conversation.',
      },
      description: {
        type: 'string',
        description: 'Short human-readable description of what this agent does (shown in status UI).',
      },
    },
    required: ['prompt', 'description'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const prompt = input['prompt'] as string
    const description = input['description'] as string | undefined ?? prompt.slice(0, 60)

    const agentId = generateAgentId()
    const task = registerAgentTask(agentId, prompt, description)

    const system = getSessionSystemPrompt()
    const tools = getWorkerTools()

    // Fire-and-Observe: do NOT await, sub-agent runs concurrently
    void runSubAgent(agentId, prompt, tools, system, task.abortController.signal)

    return {
      output: JSON.stringify({
        taskId: agentId,
        description,
        status: 'running',
        message: `Sub-agent started. Use TaskGet("${agentId}") to check status. A <task_notification> will arrive when complete.`,
      }),
    }
  },
})
