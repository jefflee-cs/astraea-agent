import { test, expect } from 'bun:test'
import type OpenAI from 'openai'
import { mapOpenAIUsage, mapDeepSeekUsage } from './usageAccounting'

// 合成 usage 用 as 转型即可：mapper 只读取它声明的字段，纯函数无网络。

test('mapOpenAIUsage splits cached tokens out of prompt_tokens', () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
    prompt_tokens_details: { cached_tokens: 800 },
  } as OpenAI.CompletionUsage
  expect(mapOpenAIUsage(usage)).toEqual({
    input: 200, output: 50, cacheRead: 800, cacheCreation: 0,
  })
})

test('mapOpenAIUsage degenerates gracefully when cache fields absent', () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
  } as OpenAI.CompletionUsage
  const m = mapOpenAIUsage(usage)
  expect(m.input).toBe(1000)
  expect(m.cacheRead).toBe(0)
  expect(m.cacheCreation).toBe(0)
})

test('mapDeepSeekUsage uses cache-hit/miss split', () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
    prompt_cache_hit_tokens: 900,
    prompt_cache_miss_tokens: 100,
  } as unknown as OpenAI.CompletionUsage
  expect(mapDeepSeekUsage(usage)).toEqual({
    input: 100, output: 50, cacheRead: 900, cacheCreation: 0,
  })
})

test('mapDeepSeekUsage degenerates gracefully when split absent', () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
  } as OpenAI.CompletionUsage
  const m = mapDeepSeekUsage(usage)
  expect(m.input).toBe(1000)
  expect(m.cacheRead).toBe(0)
  expect(m.cacheCreation).toBe(0)
})
