import { test, expect, beforeEach } from 'bun:test'
import {
  microcompact,
  CLEARED_MESSAGE,
  TIME_BASED_MC_CONFIG,
} from './microCompact'
import {
  setLastAssistantTs,
  resetMicrocompactState,
} from '../../state/microcompactState'
import type { UserMessage, AssistantMessage } from '../../types/message'

// ── helpers ───────────────────────────────────────────────────────────────
// 一对 assistant(tool_use) + user(tool_result) 模拟一次工具调用往返。
function toolCall(
  id: string,
  name: string,
  output: string,
): [AssistantMessage, UserMessage] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] },
  ]
}

// 取某 tool_use_id 的 tool_result 当前内容（字符串）。
function resultContent(
  msgs: (UserMessage | AssistantMessage)[],
  id: string,
): string | undefined {
  for (const m of msgs) {
    if (m.role !== 'user' || typeof m.content === 'string') continue
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.tool_use_id === id) {
        return typeof b.content === 'string' ? b.content : b.content.map(x => x.text).join('')
      }
    }
  }
  return undefined
}

const HUGE = 'x'.repeat(4000) // ~1000 token 的输出
const overThreshold = () =>
  setLastAssistantTs(Date.now() - (TIME_BASED_MC_CONFIG.gapThresholdMinutes + 5) * 60_000)
const underThreshold = () =>
  setLastAssistantTs(Date.now() - (TIME_BASED_MC_CONFIG.gapThresholdMinutes - 5) * 60_000)

beforeEach(() => resetMicrocompactState())

// ── 触发判定 ─────────────────────────────────────────────────────────────
test('gap 不足阈值 → 不触发', () => {
  underThreshold()
  const msgs = [
    ...toolCall('t1', 'Read', HUGE),
    ...toolCall('t2', 'Read', HUGE),
    ...toolCall('t3', 'Read', HUGE),
  ]
  const r = microcompact(msgs)
  expect(r.cleared).toBe(false)
  expect(r.messages).toBe(msgs) // 原数组原样返回
})

test('lastAssistantTs === null（首轮/未回填）→ no-op', () => {
  // beforeEach 已 reset → null
  const msgs = [...toolCall('t1', 'Read', HUGE), ...toolCall('t2', 'Read', HUGE), ...toolCall('t3', 'Read', HUGE)]
  const r = microcompact(msgs)
  expect(r.cleared).toBe(false)
})

test('gap ≥ 阈值 → 触发，保留最近 keepRecent 个、清掉更早的', () => {
  overThreshold()
  const msgs = [
    ...toolCall('t1', 'Read', HUGE),
    ...toolCall('t2', 'Bash', HUGE),
    ...toolCall('t3', 'Grep', HUGE),
  ]
  const r = microcompact(msgs)
  expect(r.cleared).toBe(true)
  // keepRecent=2 → 清 t1，留 t2、t3
  expect(resultContent(r.messages, 't1')).toBe(CLEARED_MESSAGE)
  expect(resultContent(r.messages, 't2')).toBe(HUGE)
  expect(resultContent(r.messages, 't3')).toBe(HUGE)
  expect(r.tokensSaved).toBeGreaterThan(0)
})

// ── allowlist ────────────────────────────────────────────────────────────
test('非 allowlist 工具（WebBrowser）不被清', () => {
  overThreshold()
  const msgs = [
    ...toolCall('w1', 'WebBrowser', HUGE),
    ...toolCall('w2', 'WebBrowser', HUGE),
    ...toolCall('w3', 'WebBrowser', HUGE),
  ]
  const r = microcompact(msgs)
  // 没有可压缩工具 → clearSet 为空 → no-op
  expect(r.cleared).toBe(false)
})

test('混合工具：只清 allowlist 内的旧结果', () => {
  overThreshold()
  const msgs = [
    ...toolCall('a1', 'Read', HUGE),       // 可压缩、最老 → 清
    ...toolCall('w1', 'WebBrowser', HUGE), // 不可压缩 → 永不清
    ...toolCall('a2', 'Grep', HUGE),       // 可压缩、最近 → 留
    ...toolCall('a3', 'Bash', HUGE),       // 可压缩、最近 → 留
  ]
  const r = microcompact(msgs)
  expect(r.cleared).toBe(true)
  expect(resultContent(r.messages, 'a1')).toBe(CLEARED_MESSAGE)
  expect(resultContent(r.messages, 'w1')).toBe(HUGE) // WebBrowser 原样
  expect(resultContent(r.messages, 'a2')).toBe(HUGE)
  expect(resultContent(r.messages, 'a3')).toBe(HUGE)
})

// ── 幂等 & 边界 ───────────────────────────────────────────────────────────
test('幂等：连跑两次，第二次 cleared:false', () => {
  overThreshold()
  const msgs = [...toolCall('t1', 'Read', HUGE), ...toolCall('t2', 'Read', HUGE), ...toolCall('t3', 'Read', HUGE)]
  const r1 = microcompact(msgs)
  expect(r1.cleared).toBe(true)
  const r2 = microcompact(r1.messages)
  expect(r2.cleared).toBe(false) // 命中的都已是占位符 → 不再算改动
})

test('调用骨架（tool_use）原封不动', () => {
  overThreshold()
  const msgs = [...toolCall('t1', 'Read', HUGE), ...toolCall('t2', 'Read', HUGE), ...toolCall('t3', 'Read', HUGE)]
  const r = microcompact(msgs)
  const asst = r.messages.find(m => m.role === 'assistant' && m.content.some(b => b.type === 'tool_use' && b.id === 't1'))
  expect(asst).toBeDefined() // t1 的 tool_use 仍在，只是它的 result 被清
})

test('可压缩结果数 ≤ keepRecent → 没东西可清', () => {
  overThreshold()
  const msgs = [...toolCall('t1', 'Read', HUGE), ...toolCall('t2', 'Read', HUGE)] // 2 个，keepRecent=2
  const r = microcompact(msgs)
  expect(r.cleared).toBe(false)
})

// ── 不可变更新 ─────────────────────────────────────────────────────────────
test('不可变更新：原数组不被 mutate', () => {
  overThreshold()
  const msgs = [...toolCall('t1', 'Read', HUGE), ...toolCall('t2', 'Read', HUGE), ...toolCall('t3', 'Read', HUGE)]
  microcompact(msgs)
  // 原数组里 t1 仍是原文
  expect(resultContent(msgs, 't1')).toBe(HUGE)
})
