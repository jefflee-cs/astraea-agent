// DeepSeek 流式适配器 — DeepSeek API 与 OpenAI 完全兼容
// 使用 OpenAI SDK 指向 https://api.deepseek.com
// 模型: deepseek-chat (V3/V4 最新), deepseek-reasoner (R1 推理)

import OpenAI from 'openai'
import { config } from '../config'
import type { Message, StreamEvent } from '../types/message'
import type { StreamOptions } from './anthropic'
import type { ToolSchema } from '../tools/Tool'
import { mapDeepSeekUsage } from './usageAccounting'
import { resolveAppliedEffort, deepseekEffectiveModel, deepseekReasoningDirective } from './reasoningEffort'

function createClient(): OpenAI {
  return new OpenAI({
    apiKey: config.deepseek.apiKey,
    baseURL: config.deepseek.baseUrl,
  })
}

export async function* streamMessageDeepSeek(
  messages: Message[],
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent> {
  const client = createClient()

  // /reason → DeepSeek 定制：reasoner 档换模型 + 注入动态 prompt 指令（见 reasoningEffort.ts）。
  const applied = resolveAppliedEffort()
  const configuredModel = options.model ?? config.deepseek.model
  const effectiveModel = deepseekEffectiveModel(applied, configuredModel)
  const directive = deepseekReasoningDirective(applied)

  const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []

  // 思考深度指令拼进 system（已有 system 则追加一行）。
  const systemText = [options.system, directive].filter(Boolean).join('\n\n')
  if (systemText) {
    chatMessages.push({ role: 'system', content: systemText })
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        chatMessages.push({ role: 'user', content: msg.content })
      } else {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const content = typeof block.content === 'string'
              ? block.content
              : block.content.map((b) => b.text).join('')
            chatMessages.push({ role: 'tool', tool_call_id: block.tool_use_id, content })
          } else {
            chatMessages.push({ role: 'user', content: block.text })
          }
        }
      }
    } else {
      const textParts = msg.content.filter((b) => b.type === 'text')
      const toolUses = msg.content.filter((b) => b.type === 'tool_use')
      const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = toolUses.map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }))
      chatMessages.push({
        role: 'assistant',
        content: textParts.map((b) => b.text).join('') || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      })
    }
  }

  const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>()
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0   // prompt_tokens 含命中缓存，需拆出按缓存价计（见 usageAccounting）
  let truncated = false   // finish_reason === 'length' → 撞输出上限被截断
  let finishReason: string | null = null

  const openaiTools: OpenAI.Chat.ChatCompletionTool[] | undefined =
    options.tools?.map((t: ToolSchema) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))

  // max_tokens 不随 /reason 变：DeepSeek 的 CoT 在独立 reasoning_content、不占此预算（见 reasoningEffort.ts）。
  const stream = await client.chat.completions.create({
    model: effectiveModel,
    max_tokens: options.maxTokens ?? config.deepseek.maxTokens,
    messages: chatMessages,
    stream: true,
    stream_options: { include_usage: true },
    ...(openaiTools?.length ? { tools: openaiTools, tool_choice: 'auto' } : {}),
  }, { signal: options.abortSignal })

  for await (const chunk of stream) {
    const choice = chunk.choices[0]

    if (chunk.usage) {
      const m = mapDeepSeekUsage(chunk.usage)
      inputTokens = m.input
      outputTokens = m.output
      cacheReadTokens = m.cacheRead
    }

    if (!choice) continue
    const delta = choice.delta

    if (delta.content) {
      yield { type: 'text', text: delta.content }
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!toolCallBuffers.has(tc.index)) {
          toolCallBuffers.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' })
        }
        const buf = toolCallBuffers.get(tc.index)!
        if (tc.id) buf.id = tc.id
        if (tc.function?.name) buf.name = tc.function.name
        if (tc.function?.arguments) buf.args += tc.function.arguments
      }
    }

    if (choice.finish_reason && !finishReason) {
      finishReason = choice.finish_reason
      truncated = finishReason === 'length'
      for (const [, buf] of toolCallBuffers) {
        let input: Record<string, unknown> = {}
        let incomplete = false
        try { input = JSON.parse(buf.args) } catch { incomplete = true }
        yield { type: 'tool_use', id: buf.id, name: buf.name, input, incomplete: incomplete || truncated }
      }
      toolCallBuffers.clear()
      // 不 return：usage 在 finish_reason 之后的「空 choices」chunk 里
    }
  }

  yield {
    type: 'message_stop',
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
    },
    stopReason: truncated ? 'max_tokens'
      : finishReason === 'tool_calls' ? 'tool_use'
      : finishReason === 'stop' ? 'end_turn'
      : 'other',
  }
}
