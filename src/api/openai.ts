// OpenAI 流式适配器 — 使用 OpenAI 官方 API（api.openai.com/v1）
// 也可通过 OPENAI_BASE_URL 指向其他 OpenAI-compatible 端点（如 Azure、第三方中转）

import OpenAI from 'openai'
import { config } from '../config'
import type { Message, StreamEvent } from '../types/message'
import type { StreamOptions } from './anthropic'
import type { ToolSchema } from '../tools/Tool'
import { resolveAppliedEffort, openaiReasoningParam } from './reasoningEffort'
import { mapOpenAIUsage } from './usageAccounting'

let _openaiClient: OpenAI | null = null

// 推理系列模型（o1 / o3 / o4-mini / gpt-5 …）在 Chat Completions 上拒绝 `max_tokens`，
// 必须改用 `max_completion_tokens`，否则返回 400 unsupported_parameter，导致「无任何回复」。
// 这些模型还不支持自定义 temperature（默认即可），我们本就没传，无需特殊处理。
export function isReasoningModel(model: string): boolean {
  return /^o\d/i.test(model) || /^gpt-5/i.test(model)
}

function getOpenAIClient(): OpenAI {
  if (!_openaiClient) {
    _openaiClient = new OpenAI({
      apiKey: config.openai.apiKey,
      baseURL: config.openai.baseUrl,
      // 429 (TPM/RPM 限流) 由 SDK 自动重试：它会读取响应的 retry-after / retry-after-ms
      // 头，按服务端建议的时长退避后重试。默认只重试 2 次，对低配额账号（如 gpt-4o
      // 30k TPM）每轮都要重发完整 system prompt + 工具 schema，很容易短暂超限，2 次不够。
      // 提到 5 次，覆盖「刚好略微超限、等几百毫秒~几秒即可」的常见瞬时限流。
      maxRetries: 5,
    })
  }
  return _openaiClient
}

export function resetOpenAIClient(): void {
  _openaiClient = null
}

export async function* streamMessageOpenAI(
  messages: Message[],
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent> {
  const client = getOpenAIClient()

  const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []

  if (options.system) {
    chatMessages.push({ role: 'system', content: options.system })
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
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))

  // 推理模型用 max_completion_tokens，其余用 max_tokens（见 isReasoningModel 注释）
  const effectiveModel = options.model ?? config.openai.model
  const reasoning = isReasoningModel(effectiveModel)
  const tokenLimit = reasoning
    ? { max_completion_tokens: options.maxTokens ?? config.openai.maxTokens }
    : { max_tokens: options.maxTokens ?? config.openai.maxTokens }

  // reasoning_effort：仅 gpt-5.x / o 系列接受。优先级 /reason 会话设置 > env > 旧静态配置兜底。
  // resolveAppliedEffort 已含 env(ASTRAEA_REASONING_EFFORT) > 会话 链；为兼容旧 OPENAI_REASONING_EFFORT
  // 配置，二者皆空时回落到 config.openai.reasoningEffort。
  const applied = resolveAppliedEffort()
  const reasoningParam = applied
    ? openaiReasoningParam(effectiveModel, applied)
    : reasoning && config.openai.reasoningEffort
      ? { reasoning_effort: config.openai.reasoningEffort as 'low' | 'medium' | 'high' }
      : {}

  const stream = await client.chat.completions.create({
    model: effectiveModel,
    ...tokenLimit,
    ...reasoningParam,
    messages: chatMessages,
    stream: true,
    stream_options: { include_usage: true },
    ...(openaiTools?.length ? { tools: openaiTools, tool_choice: 'auto' } : {}),
  }, { signal: options.abortSignal })

  for await (const chunk of stream) {
    const choice = chunk.choices[0]

    if (chunk.usage) {
      const m = mapOpenAIUsage(chunk.usage)
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
        // 截断时入参 JSON 多半残缺：parse 失败标记 incomplete，让上层拒绝执行而非写空文件
        let input: Record<string, unknown> = {}
        let incomplete = false
        try { input = JSON.parse(buf.args) } catch { incomplete = true }
        yield { type: 'tool_use', id: buf.id, name: buf.name, input, incomplete: incomplete || truncated }
      }
      toolCallBuffers.clear()
      // 不在此 return：usage 在带 finish_reason 之后的「空 choices」chunk 里，读完才有真实 output_tokens
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
