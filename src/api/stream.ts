// 流式调用统一入口 — 根据 PROVIDER 分发到不同适配器
import { config } from '../config'
import type { Message, StreamEvent } from '../types/message'
import { streamMessageAnthropic } from './anthropic'
import { streamMessageDeepSeek } from './deepseek'
import { streamMessageKimi } from './kimi'
import { streamMessageOllama } from './ollama'
import { streamMessageOpenAI, resetOpenAIClient } from './openai'
import { resetAnthropicClient } from './client'
import { recordUsage } from '../state/usageStats'

export type { StreamOptions } from './anthropic'

type StreamOpts = { system?: string; enablePromptCaching?: boolean; tools?: import('../tools/Tool').ToolSchema[]; abortSignal?: AbortSignal; maxTokens?: number; model?: string }

function dispatch(messages: Message[], options: StreamOpts): AsyncGenerator<StreamEvent> {
  if (config.provider === 'deepseek') return streamMessageDeepSeek(messages, options)
  if (config.provider === 'kimi') return streamMessageKimi(messages, options)
  if (config.provider === 'ollama') return streamMessageOllama(messages, options)
  if (config.provider === 'openai') return streamMessageOpenAI(messages, options)
  return streamMessageAnthropic(messages, options)
}

export async function* streamMessage(
  messages: Message[],
  options: StreamOpts = {},
): AsyncGenerator<StreamEvent> {
  // 这是所有 LLM 调用的唯一收口：主对话 / 子 agent / 记忆提取 / 压缩摘要都穿过它。
  // 在此拦截 message_stop 的 usage 累加进 session 级用量（/usage 读它），零遗漏。
  // 解析出本次实际生效的 provider + 模型，给用量打准确标签 → 喂价目表算钱。
  const provider = config.provider
  const model = options.model ?? (config as unknown as Record<string, { model?: string }>)[provider]?.model ?? 'unknown'
  for await (const event of dispatch(messages, options)) {
    if (event.type === 'message_stop') recordUsage(model, provider, event.usage)
    yield event
  }
}

// 切换 provider 后调用，确保下次请求使用新凭证
export function resetAllApiClients(): void {
  resetAnthropicClient()
  resetOpenAIClient()
  // deepseek 每次调用都创建新 client，无需 reset
}
