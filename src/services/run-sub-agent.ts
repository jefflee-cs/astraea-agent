// 子 Agent 执行引擎 — 独立上下文的 Claude 会话循环
// 与主 query.ts 同构，但额外支持：pending message 注入、输出 ring buffer、AbortController

import { streamMessage } from '../api/stream'
import type { UserMessage, AssistantMessage, TextBlock, ToolUseBlock, ToolResultBlock } from '../types/message'
import type { Tool, ToolSchema } from '../tools/Tool'
import {
  appendAgentOutput,
  drainPendingMessages,
  completeAgentTask,
  failAgentTask,
} from './agent-state'
import { enqueueAgentNotification } from './notification-queue'

const MAX_TURNS = 30

export async function runSubAgent(
  agentId: string,
  prompt: string,
  tools: Tool[],
  system: string,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = Date.now()

  const toolSchemas: ToolSchema[] = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))

  let messages: (UserMessage | AssistantMessage)[] = [
    { role: 'user', content: prompt },
  ]

  let turnCount = 0
  let lastText = ''

  try {
    while (turnCount < MAX_TURNS) {
      if (signal.aborted) break

      // Inject any pending messages (sent via SendMessageTool from main agent)
      const pending = drainPendingMessages(agentId)
      if (pending.length > 0) {
        const last = messages[messages.length - 1]
        if (last?.role === 'user') {
          const content = typeof last.content === 'string'
            ? [{ type: 'text' as const, text: last.content }, ...pending.map(m => ({ type: 'text' as const, text: m }))]
            : [...last.content as TextBlock[], ...pending.map(m => ({ type: 'text' as const, text: m }))]
          messages = [...messages.slice(0, -1), { role: 'user', content }]
        } else {
          messages = [
            ...messages,
            { role: 'user', content: pending.map(m => ({ type: 'text' as const, text: m })) },
          ]
        }
      }

      turnCount++
      const contentBlocks: (TextBlock | ToolUseBlock)[] = []
      const toolUseBlocks: ToolUseBlock[] = []
      let turnText = ''

      for await (const event of streamMessage(messages, {
        system,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      })) {
        if (signal.aborted) break

        if (event.type === 'text') {
          turnText += event.text
          const last = contentBlocks.at(-1)
          if (last?.type === 'text') last.text += event.text
          else contentBlocks.push({ type: 'text', text: event.text })
          appendAgentOutput(agentId, event.text)
        } else if (event.type === 'tool_use') {
          const block: ToolUseBlock = {
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: event.input,
          }
          contentBlocks.push(block)
          toolUseBlocks.push(block)
          appendAgentOutput(agentId, `[tool: ${event.name}]`)
        }
      }

      if (signal.aborted) break

      if (turnText) lastText = turnText

      const assistantMessage: AssistantMessage = { role: 'assistant', content: contentBlocks }

      if (toolUseBlocks.length === 0) {
        // No tool calls → sub-agent is done
        break
      }

      // Execute tools serially (sub-agents don't need parallel tool execution)
      const toolResultBlocks: ToolResultBlock[] = []
      for (const toolUse of toolUseBlocks) {
        if (signal.aborted) break
        const tool = tools.find(t => t.name === toolUse.name)
        let output: string
        let isError = false
        if (!tool) {
          output = `Tool not found: "${toolUse.name}". Available: ${tools.map(t => t.name).join(', ')}`
          isError = true
        } else {
          try {
            // 子 agent 无交互 TTY：isInteractive:false → 工具遇 ask 一律 fail-closed deny，绝不挂起
            // （Permission & Safety Technical Spec §3.0）
            const res = await tool.call(toolUse.input, { mode: 'default', isInteractive: false, agentId })
            output = res.output
            isError = res.isError ?? false
          } catch (err) {
            output = `Tool error: ${String(err)}`
            isError = true
          }
        }
        appendAgentOutput(agentId, `[tool_result: ${output.slice(0, 200)}]`)
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: output,
          is_error: isError || undefined,
        })
      }

      const toolResultMessage: UserMessage = { role: 'user', content: toolResultBlocks }
      messages = [...messages, assistantMessage, toolResultMessage]
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!signal.aborted) {
      if (failAgentTask(agentId, msg)) {
        enqueueAgentNotification(agentId, 'failed', undefined, msg, Date.now() - startedAt)
      }
    }
    return
  }

  if (signal.aborted) {
    enqueueAgentNotification(agentId, 'killed', undefined, undefined, Date.now() - startedAt)
    return
  }

  if (completeAgentTask(agentId, lastText)) {
    enqueueAgentNotification(agentId, 'completed', lastText, undefined, Date.now() - startedAt)
  }
}
