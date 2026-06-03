// 轻量一次性非流式 AI 调用 — 专供工具内部的二次处理（如 WebFetch 内容提炼）
//
// 小模型选择策略（与 best-practices 的 queryHaiku 对齐）：
//   anthropic → claude-haiku-4-5-20251001（最快最廉价）
//   openai    → gpt-4o-mini（同等定位的 OpenAI 轻量模型）
//   deepseek  → deepseek-chat（已足够快，无更小模型）
//   ollama    → 使用配置的本地模型

import OpenAI from 'openai'
import { config } from '../config'
import { getClient } from './client'
import { isReasoningModel } from './openai'

const ANTHROPIC_SMALL_MODEL = 'claude-haiku-4-5-20251001'
const OPENAI_SMALL_MODEL = 'gpt-4o-mini'

export async function querySmallModel(
  userPrompt: string,
  signal?: AbortSignal,
  systemPrompt?: string,
): Promise<string> {
  const provider = config.provider

  if (provider === 'anthropic') {
    const client = getClient()
    const msg = await client.messages.create(
      {
        model: ANTHROPIC_SMALL_MODEL,
        max_tokens: 4096,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: [{ role: 'user', content: userPrompt }],
      },
      signal ? { signal } : undefined,
    )
    const block = msg.content[0]
    return block && 'text' in block ? block.text : ''
  }

  // OpenAI-compatible providers (openai, deepseek, ollama)
  const clientCfg =
    provider === 'openai'
      ? { baseURL: config.openai.baseUrl, apiKey: config.openai.apiKey, model: OPENAI_SMALL_MODEL }
      : provider === 'deepseek'
      ? { baseURL: config.deepseek.baseUrl, apiKey: config.deepseek.apiKey, model: config.deepseek.model }
      : { baseURL: config.ollama.baseUrl, apiKey: 'ollama', model: config.ollama.model }

  const openaiClient = new OpenAI({ baseURL: clientCfg.baseURL, apiKey: clientCfg.apiKey, maxRetries: 5 })
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: userPrompt })

  const tokenLimit = isReasoningModel(clientCfg.model)
    ? { max_completion_tokens: 4096 }
    : { max_tokens: 4096 }
  const resp = await openaiClient.chat.completions.create(
    { model: clientCfg.model, ...tokenLimit, messages },
    signal ? { signal } : undefined,
  )
  return resp.choices[0]?.message?.content ?? ''
}
