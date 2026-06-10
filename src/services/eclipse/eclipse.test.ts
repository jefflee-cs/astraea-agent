import { test, expect, beforeEach, afterEach } from 'bun:test'
import { config } from '../../config'
import { recordInputTokens, resetContextTokens } from '../../state/contextTokens'
import { thresholds, effectiveWindow } from '../compact/window'
import {
  resetEclipse,
  setStaged,
  commitStaged,
  getCommitted,
  getStaged,
  projectView,
  type ConvMessage,
  type StagedCollapse,
} from './store'
import { commitIfNeeded, drainOnOverflow } from './eclipse'
import { parseSpans, middleRegion } from './ctxAgent'

function user(text: string): ConvMessage { return { role: 'user', content: text } }
function asst(text: string): ConvMessage { return { role: 'assistant', content: [{ type: 'text', text }] } }
function staged(archived: ConvMessage[], summary: string, risk: number): StagedCollapse {
  return { archived, summary, risk, stagedAt: Date.now() }
}

beforeEach(() => {
  resetEclipse()
  resetContextTokens()
  config.eclipse = true
})
afterEach(() => {
  resetEclipse()
  resetContextTokens()
})

// ── projectView：内容匹配 + 占位符 + 角色归一 ────────────────────────────────
test('projectView: 折中段，head/tail 内容保留、被折内容消失', () => {
  const msgs = [user('原始诉求'), asst('过程A'), asst('过程B'), user('最近一句')]
  commitStaged(staged([msgs[1]!, msgs[2]!], '中段已折', 0.2))
  const dump = JSON.stringify(projectView(msgs))
  // 不变量：摘要在、head/tail 文本在、被折的过程文本不在
  expect(dump).toContain('中段已折')
  expect(dump).toContain('原始诉求')
  expect(dump).toContain('最近一句')
  expect(dump).not.toContain('过程A')
  expect(dump).not.toContain('过程B')
})

test('projectView: 占位符与相邻同角色合并（角色归一）', () => {
  // 折掉中间 assistant 段后，user 占位符会贴着前面的 user → 必须合并，避免 user,user
  const msgs = [user('Q1'), asst('A1'), user('Q2')]
  commitStaged(staged([msgs[1]!], 'A1 已折', 0.1))
  const view = projectView(msgs)
  // Q1(user) + 占位符(user) + Q2(user) → 全合并成 1 条 user
  expect(view.length).toBe(1)
  expect(view[0]!.role).toBe('user')
})

test('projectView: 匹配不到的段跳过，不破坏其余', () => {
  const msgs = [user('a'), asst('b')]
  // 故意 commit 一个不存在于 msgs 的段
  commitStaged(staged([asst('不存在')], 'x', 0.1))
  const view = projectView(msgs)
  expect(view).toEqual(msgs)
})

test('projectView: 关闭折叠（无 committed）原样返回', () => {
  const msgs = [user('a'), asst('b')]
  expect(projectView(msgs)).toBe(msgs)
})

// ── drainOnOverflow：排空全部 staged（无视阈值）────────────────────────────────
test('drainOnOverflow: 把所有 staged 提交为 committed', () => {
  setStaged([staged([asst('x')], 's1', 0.1), staged([asst('y')], 's2', 0.4)])
  const drained = drainOnOverflow()
  expect(drained.length).toBe(2)
  expect(getCommitted().length).toBe(2)
  expect(getStaged().length).toBe(0)
})

test('drainOnOverflow: 关闭时 no-op', () => {
  config.eclipse = false
  setStaged([staged([asst('x')], 's1', 0.1)])
  expect(drainOnOverflow().length).toBe(0)
  expect(getCommitted().length).toBe(0)
})

// ── commitIfNeeded：到 0.85 才折，低 risk 先折 ─────────────────────────────────
test('commitIfNeeded: 未达 commit 线不折', () => {
  config.provider = 'anthropic'
  const used = thresholds(effectiveWindow(config.anthropic.contextWindow, config.anthropic.maxTokens)).eclipseCommit
  recordInputTokens(used - 1)
  setStaged([staged([asst('x')], 's', 0.1)])
  expect(commitIfNeeded([user('a'), asst('x'), user('b')], 0).length).toBe(0)
})

test('commitIfNeeded: 达线后低 risk 先折', () => {
  // 缩小窗口让 token 数学好构造
  const savedWin = config.anthropic.contextWindow
  const savedMax = config.anthropic.maxTokens
  const savedProvider = config.provider
  config.provider = 'anthropic'
  config.anthropic.contextWindow = 1000
  config.anthropic.maxTokens = 200
  try {
    // eff = 1000 - min(200+2000, 500) = 500；commit = floor(500*0.85) = 425
    recordInputTokens(450) // ≥ 425
    const big = asst('x'.repeat(3000)) // ~750 token，撑高 projected
    const small = asst('y'.repeat(40))
    const msgs = [user('head'), small, big, user('tail')]
    // 两个 staged：high risk 0.4 在前，low risk 0.1 在后；应先折 low
    setStaged([staged([big], 'big-折', 0.4), staged([small], 'small-折', 0.1)])
    const out = commitIfNeeded(msgs, 0)
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0]!.summary).toBe('small-折') // 低 risk 先
  } finally {
    config.anthropic.contextWindow = savedWin
    config.anthropic.maxTokens = savedMax
    config.provider = savedProvider
  }
})

// ── ctxAgent: parseSpans 容错 ────────────────────────────────────────────────
test('parseSpans: 解析裸 JSON 数组', () => {
  const r = parseSpans('[{"start":0,"end":1,"summary":"s","risk":0.3}]')
  expect(r.length).toBe(1)
  expect(r[0]!.summary).toBe('s')
})

test('parseSpans: 容忍 ```json 包裹与前后文字', () => {
  const raw = 'Here:\n```json\n[{"start":1,"end":2,"summary":"ok","risk":0.2}]\n```\ndone'
  const r = parseSpans(raw)
  expect(r.length).toBe(1)
  expect(r[0]!.start).toBe(1)
})

test('parseSpans: 非数组/坏串 → []', () => {
  expect(parseSpans('not json').length).toBe(0)
  expect(parseSpans('{"a":1}').length).toBe(0)
})

// ── ctxAgent: middleRegion head/tail 保护 ────────────────────────────────────
test('middleRegion: 保护首个 user turn 与最近 tail', () => {
  // 中段消息做大（~50 token/条），tail 预算(eff*0.15=15) 只够保护最后一条小消息
  const big = 'm'.repeat(200)
  const msgs: ConvMessage[] = [
    user('原始诉求'),                       // idx0 HEAD 保护
    asst(big), asst(big), asst(big),        // idx1-3 中段
    user('最近'),                           // idx4 tail（小，单独被保护）
  ]
  const region = middleRegion(msgs, 100) // tailBudget = 15 token
  const idxs = region.map(r => r.idx)
  expect(idxs).not.toContain(0) // head 不在中段
  expect(idxs).not.toContain(4) // tail 不在中段
  expect(idxs).toContain(1)
  expect(idxs).toContain(3)
})

test('middleRegion: 太短无中段', () => {
  expect(middleRegion([user('a'), asst('b')], 1000).length).toBe(0)
})
