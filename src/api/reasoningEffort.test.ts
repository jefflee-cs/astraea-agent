import { test, expect, afterEach } from 'bun:test'
import {
  getEffortEnvOverride,
  resolveAppliedEffort,
  currentEffortStatus,
  toPersistableEffort,
  openaiReasoningParam,
  anthropicSupportsThinking,
  anthropicThinkingParam,
  deepseekUsesReasoner,
  deepseekEffectiveModel,
  deepseekReasoningDirective,
} from './reasoningEffort'

const ENV_KEY = 'ASTRAEA_REASONING_EFFORT'
afterEach(() => {
  delete process.env[ENV_KEY]
})

// ─── 优先级链 ────────────────────────────────────────────────────────────────
test('env override: explicit auto/unset forces no-effort (null), beating session', () => {
  process.env[ENV_KEY] = 'auto'
  expect(getEffortEnvOverride()).toBeNull()
  expect(resolveAppliedEffort('high')).toBeUndefined() // env auto 压过会话 high
  process.env[ENV_KEY] = 'unset'
  expect(resolveAppliedEffort('high')).toBeUndefined()
})

test('env override: a valid level wins over session', () => {
  process.env[ENV_KEY] = 'low'
  expect(getEffortEnvOverride()).toBe('low')
  expect(resolveAppliedEffort('high')).toBe('low')
})

test('env unset → falls through to session; bogus env ignored', () => {
  expect(getEffortEnvOverride()).toBeUndefined()
  expect(resolveAppliedEffort('medium')).toBe('medium')
  expect(resolveAppliedEffort(undefined)).toBeUndefined()
  process.env[ENV_KEY] = 'banana'
  expect(getEffortEnvOverride()).toBeUndefined()
  expect(resolveAppliedEffort('high')).toBe('high')
})

test('currentEffortStatus reports source', () => {
  expect(currentEffortStatus(undefined)).toEqual({ effort: undefined, source: 'auto' })
  expect(currentEffortStatus('high')).toEqual({ effort: 'high', source: 'session' })
  process.env[ENV_KEY] = 'low'
  expect(currentEffortStatus('high')).toEqual({ effort: 'low', source: 'env' })
  process.env[ENV_KEY] = 'auto'
  expect(currentEffortStatus('high')).toEqual({ effort: undefined, source: 'env' })
})

// ─── 持久化过滤 ──────────────────────────────────────────────────────────────
test('toPersistableEffort: low/medium/high persist, max session-only', () => {
  expect(toPersistableEffort('low')).toBe('low')
  expect(toPersistableEffort('medium')).toBe('medium')
  expect(toPersistableEffort('high')).toBe('high')
  expect(toPersistableEffort('max')).toBeUndefined()
})

// ─── OpenAI 映射 ─────────────────────────────────────────────────────────────
test('openai mapper: reasoning models get param, max→high, others empty', () => {
  expect(openaiReasoningParam('gpt-5.1', 'high')).toEqual({ reasoning_effort: 'high' })
  expect(openaiReasoningParam('o3', 'medium')).toEqual({ reasoning_effort: 'medium' })
  expect(openaiReasoningParam('gpt-5', 'max')).toEqual({ reasoning_effort: 'high' }) // max 降级
  expect(openaiReasoningParam('gpt-4o', 'high')).toEqual({}) // 非推理模型略过
  expect(openaiReasoningParam('gpt-5', undefined)).toEqual({}) // 无 effort
})

// ─── Anthropic 映射 ──────────────────────────────────────────────────────────
test('anthropic supports thinking only on claude 4 / 3.7', () => {
  expect(anthropicSupportsThinking('claude-sonnet-4-6')).toBe(true)
  expect(anthropicSupportsThinking('claude-opus-4-8')).toBe(true)
  expect(anthropicSupportsThinking('claude-3-7-sonnet')).toBe(true)
  expect(anthropicSupportsThinking('claude-haiku-4-5-20251001')).toBe(false)
  expect(anthropicSupportsThinking('claude-3-5-sonnet')).toBe(false)
})

test('anthropic mapper: emits thinking budget, 1024 ≤ N < maxTokens, max clamps', () => {
  const p = anthropicThinkingParam('claude-sonnet-4-6', 'medium', 32000)
  expect(p.thinking?.type).toBe('enabled')
  const n = p.thinking!.budget_tokens
  expect(n).toBeGreaterThanOrEqual(1024)
  expect(n).toBeLessThan(32000)

  // max target (32768) must clamp below maxTokens (32000)
  const pmax = anthropicThinkingParam('claude-sonnet-4-6', 'max', 32000)
  expect(pmax.thinking!.budget_tokens).toBeLessThan(32000)
  expect(pmax.thinking!.budget_tokens).toBeGreaterThanOrEqual(1024)

  // non-thinking model → empty
  expect(anthropicThinkingParam('claude-haiku-4-5-20251001', 'high', 32000)).toEqual({})
  // no effort → empty
  expect(anthropicThinkingParam('claude-sonnet-4-6', undefined, 32000)).toEqual({})
  // not enough room (tiny maxTokens) → empty, never errors
  expect(anthropicThinkingParam('claude-sonnet-4-6', 'low', 1500)).toEqual({})
})

// ─── DeepSeek 定制：换模型 + 动态 prompt ─────────────────────────────────────
test('deepseekUsesReasoner: only medium/high/max', () => {
  expect(deepseekUsesReasoner(undefined)).toBe(false) // auto
  expect(deepseekUsesReasoner('low')).toBe(false)
  expect(deepseekUsesReasoner('medium')).toBe(true)
  expect(deepseekUsesReasoner('high')).toBe(true)
  expect(deepseekUsesReasoner('max')).toBe(true)
})

test('deepseekEffectiveModel: reasoner levels switch model, others keep configured', () => {
  expect(deepseekEffectiveModel(undefined, 'deepseek-chat')).toBe('deepseek-chat') // auto
  expect(deepseekEffectiveModel('low', 'deepseek-chat')).toBe('deepseek-chat')
  expect(deepseekEffectiveModel('high', 'deepseek-chat')).toBe('deepseek-reasoner')
  expect(deepseekEffectiveModel('max', 'deepseek-chat')).toBe('deepseek-reasoner')
})

test('deepseekReasoningDirective: escalates; low/auto inject nothing; max self-verifies', () => {
  expect(deepseekReasoningDirective(undefined)).toBeUndefined()
  expect(deepseekReasoningDirective('low')).toBeUndefined()
  expect(deepseekReasoningDirective('medium')).toBeDefined()
  expect(deepseekReasoningDirective('high')).toBeDefined()
  const max = deepseekReasoningDirective('max')!
  expect(max).toContain('校验') // max 档要求自我校验
  // 递进：max 指令比 medium 更长（更重）
  expect(max.length).toBeGreaterThan(deepseekReasoningDirective('medium')!.length)
})

// ─── 安全兜底：任何组合都不抛错 ──────────────────────────────────────────────
test('safe fallback: no input combination throws', () => {
  const models = ['gpt-4o', 'gpt-5', 'o3', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'weird-model']
  const efforts = ['low', 'medium', 'high', 'max', undefined] as const
  expect(() => {
    for (const m of models) for (const e of efforts) {
      openaiReasoningParam(m, e)
      anthropicThinkingParam(m, e, 32000)
      deepseekEffectiveModel(e, 'deepseek-chat')
      deepseekReasoningDirective(e)
    }
  }).not.toThrow()
})
