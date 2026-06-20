import { test, expect, afterEach, beforeEach } from 'bun:test'
import { findCommand } from './registry'
import { executeReason, showReason } from './reason'
import { getSessionEffort, unsetSessionEffort } from '../state/reasoningEffort'
import { config } from '../config'

const ENV_KEY = 'ASTRAEA_REASONING_EFFORT'
// 环境的 PROVIDER 可能是任意值；这些用例除非显式覆盖，否则固定到 anthropic（不触发 DeepSeek 换模型确认门）。
let _prevProvider: typeof config.provider
beforeEach(() => {
  delete process.env[ENV_KEY]
  unsetSessionEffort()
  _prevProvider = config.provider
  config.provider = 'anthropic'
})
afterEach(() => {
  delete process.env[ENV_KEY]
  unsetSessionEffort()
  config.provider = _prevProvider
})

test('/reason is in the unified command table: local, user-invocable, NOT model-invocable', () => {
  const cmd = findCommand('reason')
  expect(cmd).toBeDefined()
  expect(cmd!.type).toBe('local')
  expect(cmd!.userInvocable).toBe(true)
  expect(cmd!.modelInvocable).toBe(false)
  expect(cmd!.source).toBe('builtin')
})

test('round-trip: set → show → auto', () => {
  // set
  const set = executeReason('high')
  expect(set.message).toContain('high')
  expect(getSessionEffort()).toBe('high')
  expect(set.disk).toBe('write')
  expect(set.value).toBe('high')

  // show reflects current session value + source
  const shown = showReason()
  expect(shown).toContain('high')
  expect(shown).toContain('session')

  // auto clears
  const cleared = executeReason('auto')
  expect(cleared.disk).toBe('clear')
  expect(getSessionEffort()).toBeUndefined()
})

test('max is session-only (not persisted to disk)', () => {
  const r = executeReason('max')
  expect(getSessionEffort()).toBe('max')
  expect(r.disk).toBe('none') // not persisted
  expect(r.message).toContain('session only')
})

test('invalid arg: message + state unchanged', () => {
  executeReason('medium')
  const r = executeReason('bogus')
  expect(r.message.toLowerCase()).toContain('invalid')
  expect(r.disk).toBe('none')
  expect(getSessionEffort()).toBe('medium') // unchanged
})

test('deepseek: reasoner level (high) requires --confirm before applying', () => {
  const prev = config.provider
  config.provider = 'deepseek'
  try {
    // 未确认：不落地，state 不变
    const r = executeReason('high')
    expect(r.disk).toBe('none')
    expect(getSessionEffort()).toBeUndefined()
    expect(r.message).toContain('--confirm')
    expect(r.message.toLowerCase()).toContain('reasoner')

    // 确认后：真正落地
    const r2 = executeReason('high --confirm')
    expect(getSessionEffort()).toBe('high')
    expect(r2.disk).toBe('write')

    // low 不触发确认（不开 reasoner）
    unsetSessionEffort()
    const r3 = executeReason('low')
    expect(getSessionEffort()).toBe('low')
    expect(r3.message).not.toContain('--confirm')
  } finally {
    config.provider = prev
  }
})

test('no-arg shows current; auto state reads as auto', () => {
  const r = executeReason(undefined)
  expect(r.disk).toBe('none')
  expect(r.message.toLowerCase()).toContain('auto')
})
