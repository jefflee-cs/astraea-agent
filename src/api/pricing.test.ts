import { test, expect } from 'bun:test'
import { computeCost, lookupPrice, CACHE_READ_MULT, CACHE_WRITE_MULT } from './pricing'

test('Anthropic Opus 4.8 priced at $5/$25 per MTok', () => {
  // 1M input + 1M output = $5 + $25 = $30
  const { usd, local } = computeCost('claude-opus-4-8', 'anthropic', {
    input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0,
  })
  expect(local).toBe(false)
  expect(usd).toBeCloseTo(30, 6)
})

test('cache read bills 0.1x, cache write 1.25x of input price', () => {
  // 1M cache_read at $5 base → $5 * 0.1 = $0.50; 1M cache_creation → $5 * 1.25 = $6.25
  const { usd } = computeCost('claude-opus-4-8', 'anthropic', {
    input: 0, output: 0, cacheRead: 1_000_000, cacheCreation: 1_000_000,
  })
  expect(CACHE_READ_MULT).toBe(0.1)
  expect(CACHE_WRITE_MULT).toBe(1.25)
  expect(usd).toBeCloseTo(0.5 + 6.25, 6)
})

test('ollama (local) is free regardless of model id', () => {
  const { usd, local } = computeCost('qwen2.5:7b', 'ollama', {
    input: 5_000_000, output: 2_000_000, cacheRead: 0, cacheCreation: 0,
  })
  expect(local).toBe(true)
  expect(usd).toBe(0)
})

test('unknown non-local model is unpriced (null), not guessed', () => {
  const { usd, local } = computeCost('some-future-gpt', 'openai', {
    input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0,
  })
  expect(local).toBe(false)
  expect(usd).toBeNull()
})

test('prefix match handles dated-snapshot suffixes', () => {
  expect(lookupPrice('claude-haiku-4-5-20251001')).toEqual({ inputPerMTok: 1, outputPerMTok: 5 })
})
