// Anthropic 流式适配器
// 参考源码: claude-code-main/src/services/api/claude.ts

import type { Message as SDKMessage, RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages'
import { config } from '../config'
import type { Message, StreamEvent } from '../types/message'
import { toAPIMessage } from '../types/message'
import type { ToolSchema } from '../tools/Tool'
import { normalizeMessagesForAPI } from '../utils/messages'
import { getClient } from './client'
import { resolveAppliedEffort, anthropicThinkingParam } from './reasoningEffort'

export interface StreamOptions {
  system?: string
  enablePromptCaching?: boolean
  tools?: ToolSchema[]
  abortSignal?: AbortSignal
  // 单次输出上限覆盖（压缩摘要用更小的上限）。缺省回退到各 provider 配置的 maxTokens。
  maxTokens?: number
  // 单次模型覆盖（skill frontmatter 的 model 字段经此 per-query 生效）。缺省回退到 provider 配置 model。
  model?: string
}

export async function* streamMessageAnthropic(
  messages: Message[],
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent> {
  const client = getClient()
  // normalizeMessagesForAPI 负责合并连续 user 消息、过滤空白 assistant 等
  // toAPIMessage 做最终类型转换（TextBlock → ContentBlockParam）
  const apiMessages = normalizeMessagesForAPI(messages).map(toAPIMessage)

  // ephemeral 缓存 5 分钟，命中后省约 90% input token 费用
  const system = options.system
    ? options.enablePromptCaching
      ? [{ type: 'text' as const, text: options.system, cache_control: { type: 'ephemeral' as const } }]
      : options.system
    : undefined

  // /reason → extended thinking。预算自动夹在 max_tokens 之下，不支持 thinking 的模型自动略过。
  const effModel = options.model ?? config.anthropic.model
  const effMaxTokens = options.maxTokens ?? config.anthropic.maxTokens
  const thinkingParam = anthropicThinkingParam(effModel, resolveAppliedEffort(), effMaxTokens)

  const stream = client.messages.stream({
    model: effModel,
    max_tokens: effMaxTokens,
    system: system as string | undefined,
    messages: apiMessages,
    ...thinkingParam,
    ...(options.tools?.length
      ? {
          tools: options.tools as Parameters<typeof client.messages.stream>[0]['tools'],
          tool_choice: { type: 'auto' as const },
        }
      : {}),
  }, { signal: options.abortSignal })

  let currentToolId = ''
  let currentToolName = ''
  let inputJsonBuffer = ''

  for await (const event of stream as AsyncIterable<RawMessageStreamEvent>) {
    switch (event.type) {
      case 'content_block_start': {
        if (event.content_block.type === 'tool_use') {
          currentToolId = event.content_block.id
          currentToolName = event.content_block.name
          inputJsonBuffer = ''
        }
        break
      }

      case 'content_block_delta': {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text }
        } else if (event.delta.type === 'input_json_delta') {
          inputJsonBuffer += event.delta.partial_json
        }
        break
      }

      case 'content_block_stop': {
        if (currentToolId) {
          // 入参 JSON parse 失败 = 被输出上限截断在工具调用中途，标记 incomplete 让上层拒绝执行
          let input: Record<string, unknown> = {}
          let incomplete = false
          try { input = JSON.parse(inputJsonBuffer) } catch { incomplete = true }
          yield { type: 'tool_use', id: currentToolId, name: currentToolName, input, incomplete }
          currentToolId = ''
          currentToolName = ''
          inputJsonBuffer = ''
        }
        break
      }

      case 'message_stop': {
        // 撞 max_tokens 时 content_block_stop 可能不触发：在这里兜底 flush 未完成的 tool_use
        if (currentToolId) {
          let input: Record<string, unknown> = {}
          try { input = JSON.parse(inputJsonBuffer) } catch { /* truncated */ }
          yield { type: 'tool_use', id: currentToolId, name: currentToolName, input, incomplete: true }
          currentToolId = ''
          currentToolName = ''
          inputJsonBuffer = ''
        }
        const finalMsg: SDKMessage = await stream.finalMessage()
        yield {
          type: 'message_stop',
          usage: {
            input_tokens: finalMsg.usage.input_tokens,
            output_tokens: finalMsg.usage.output_tokens,
            // 开缓存后大部分上下文都在这两笔里；不读出来上下文用量会严重低估。
            cache_read_input_tokens: finalMsg.usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: finalMsg.usage.cache_creation_input_tokens ?? 0,
          },
          stopReason: finalMsg.stop_reason === 'max_tokens' ? 'max_tokens'
            : finalMsg.stop_reason === 'tool_use' ? 'tool_use'
            : finalMsg.stop_reason === 'end_turn' ? 'end_turn'
            : finalMsg.stop_reason === 'stop_sequence' ? 'stop_sequence'
            : 'other',
        }
        return
      }

      default:
        break
    }
  }
}
