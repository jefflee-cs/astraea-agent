import { test, expect } from 'bun:test'
import { renderMarkdown } from './markdown'

// chalk truecolor 序列（renderMarkdown 在非 TTY 下强制 level 3）。
const DEEP_GREEN = '\x1b[38;2;46;125;50m' // #2e7d32
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'

test('⟦ok⟧ 结论 → 深绿，标记被吞掉', () => {
  const out = renderMarkdown('⟦ok⟧ 全部 5 个问题已解决。')
  expect(out).toContain(DEEP_GREEN)
  expect(out).not.toContain('⟦ok⟧')
  expect(out).toContain('全部 5 个问题已解决。')
})

test('⟦err⟧ 结论 → 红', () => {
  const out = renderMarkdown('⟦err⟧ 测试 3 项 fail。')
  expect(out).toContain(RED)
  expect(out).not.toContain('⟦err⟧')
})

test('⟦warn⟧ 结论 → 黄', () => {
  const out = renderMarkdown('⟦warn⟧ 改完 X，还剩 Y，要我接着做吗？')
  expect(out).toContain(YELLOW)
  expect(out).not.toContain('⟦warn⟧')
})

test('深绿不同于工具/状态行的浅绿（ANSI green 31→32）', () => {
  // 工具行用 c.green（\x1b[32m）；verdict 用 hex 深绿。二者序列必须不同。
  const out = renderMarkdown('⟦ok⟧ 通过。')
  expect(out).not.toContain('\x1b[32m')
})

test('普通正文不被误染', () => {
  const out = renderMarkdown('普通一句话，没有结论标记。')
  expect(out).not.toContain(DEEP_GREEN)
  expect(out).not.toContain('⟦')
  expect(out).toContain('普通一句话')
})

test('标记必须在行首才生效（句中 ⟦ok⟧ 不上色）', () => {
  const out = renderMarkdown('这句话里出现了 ⟦ok⟧ 但不在行首。')
  expect(out).not.toContain(DEEP_GREEN)
})
