// provider 原始 usage → 统一 token 口径（input / output / cacheRead / cacheCreation）。
//
// 为什么要拆出纯函数：OpenAI 与 DeepSeek 的 prompt_tokens 都「包含」命中缓存的部分，
// 直接拿 prompt_tokens 当 input 会把缓存命中按全价重复计费（见 EVAL-001 F1）。这里把
// 缓存命中拆出来归到 cacheRead，再让 pricing.ts 按 provider 倍率计价。
//
// 纯函数、不碰网络 → 可用合成 usage 单测（见 usageAccounting.test.ts）。

import type OpenAI from 'openai'

/** 统一口径：四项 token，对齐 pricing.UsageTokens / recordUsage 的累加项。 */
export interface MappedUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

/**
 * OpenAI：prompt_tokens 含命中缓存。cacheRead = prompt_tokens_details.cached_tokens（缺省 0），
 * input = prompt_tokens - cacheRead。OpenAI 自动缓存无写入费 → cacheCreation 恒 0。
 */
export function mapOpenAIUsage(usage: OpenAI.CompletionUsage): MappedUsage {
  const prompt = usage.prompt_tokens || 0
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    input: prompt - cacheRead,
    output: usage.completion_tokens || 0,
    cacheRead,
    cacheCreation: 0,
  }
}

// DeepSeek 在 OpenAI 兼容 usage 上额外返回这两项，但不在 OpenAI SDK 类型里 → 窄化扩展后读取。
type DeepSeekUsage = OpenAI.CompletionUsage & {
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
}

/**
 * DeepSeek：prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens。
 * input = prompt_cache_miss_tokens（缺省退化为 prompt_tokens），cacheRead = prompt_cache_hit_tokens（缺省 0）。
 * DeepSeek 无单独写入费 → cacheCreation 恒 0。
 */
export function mapDeepSeekUsage(usage: OpenAI.CompletionUsage): MappedUsage {
  const u = usage as DeepSeekUsage
  const prompt = u.prompt_tokens || 0
  const cacheRead = u.prompt_cache_hit_tokens ?? 0
  const input = u.prompt_cache_miss_tokens ?? prompt
  return {
    input,
    output: u.completion_tokens || 0,
    cacheRead,
    cacheCreation: 0,
  }
}
