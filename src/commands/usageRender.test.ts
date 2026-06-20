import { test, expect } from 'bun:test'
import { renderUsage } from './usageRender'
import type { ModelUsage } from '../state/usageStats'

const row = (over: Partial<ModelUsage>): ModelUsage => ({
  model: 'claude-opus-4-8', provider: 'anthropic',
  input: 0, output: 0, cacheRead: 0, cacheCreation: 0, calls: 1, ...over,
})

test('empty rows → "No model usage yet"', () => {
  expect(renderUsage([])).toContain('No model usage yet')
})

test('non-empty rows show the provider per row', () => {
  const out = renderUsage([
    row({ model: 'gpt-4o', provider: 'openai', input: 1000, output: 500 }),
    row({ model: 'deepseek-chat', provider: 'deepseek', input: 2000, output: 100 }),
  ])
  expect(out).toContain('openai/gpt-4o')
  expect(out).toContain('deepseek/deepseek-chat')
})

test('total line present', () => {
  const out = renderUsage([row({ input: 1000, output: 500 })])
  expect(out).toContain('Total')
  expect(out).toContain('USD')
})

test('unpriced note appears only when a row is unpriced', () => {
  const priced = renderUsage([row({ model: 'claude-opus-4-8', provider: 'anthropic', input: 1000 })])
  expect(priced).not.toContain('unpriced')

  const unpriced = renderUsage([row({ model: 'some-future-model', provider: 'openai', input: 1000 })])
  expect(unpriced).toContain('unpriced')
})
