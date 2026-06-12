// 流式调用统一入口 — 根据 PROVIDER 分发到不同适配器
import { config } from '../config'
import type { Message, StreamEvent } from '../types/message'
import { streamMessageAnthropic } from './anthropic'
import { streamMessageDeepSeek } from './deepseek'
import { streamMessageOllama } from './ollama'
import { streamMessageOpenAI, resetOpenAIClient } from './openai'
import { resetAnthropicClient } from './client'

export type { StreamOptions } from './anthropic'

export async function* streamMessage(
  messages: Message[],
  options: { system?: string; enablePromptCaching?: boolean; tools?: import('../tools/Tool').ToolSchema[]; abortSignal?: AbortSignal; maxTokens?: number; model?: string } = {},
): AsyncGenerator<StreamEvent> {
  if (config.provider === 'deepseek') {
    yield* streamMessageDeepSeek(messages, options)
  } else if (config.provider === 'ollama') {
    yield* streamMessageOllama(messages, options)
  } else if (config.provider === 'openai') {
    yield* streamMessageOpenAI(messages, options)
  } else {
    yield* streamMessageAnthropic(messages, options)
  }
}

// 切换 provider 后调用，确保下次请求使用新凭证
export function resetAllApiClients(): void {
  resetAnthropicClient()
  resetOpenAIClient()
  // deepseek 每次调用都创建新 client，无需 reset
}
