import { test, expect } from 'bun:test'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import { renderMarkdown } from './markdown'

// 取渲染结果里所有表格边框行，校验它们的可见宽度一致（即列对齐没错位）。
function borderWidths(rendered: string): number[] {
  return stripAnsi(rendered)
    .split('\n')
    .filter(l => /[┌├└]/.test(l))
    .map(l => stringWidth(l))
}

test('renders a GFM table with box borders', () => {
  const md = `| A | B |\n|---|---|\n| 1 | 2 |`
  const out = stripAnsi(renderMarkdown(md))
  expect(out).toContain('┌')
  expect(out).toContain('│')
  expect(out).toContain('└')
  // 表头与数据都在
  expect(out).toContain('A')
  expect(out).toContain('2')
})

test('aligns columns even with CJK (full-width) content', () => {
  const md = [
    '| 事项 | 详情 |',
    '|------|------|',
    '| 汉堡飞利浦 FDS callback 矛盾 | 需与 April 确认 |',
    '| 工勘报告 | 指向段君 |',
  ].join('\n')
  const widths = borderWidths(renderMarkdown(md))
  expect(widths.length).toBe(3) // 顶/中/底三条边框
  // 所有边框行可见宽度相等 → CJK 宽度计算正确，列没错位
  expect(new Set(widths).size).toBe(1)
})

test('emphasizes headings and bold text with color (ANSI present)', () => {
  const raw = '## 总结\n\n**重点**：完成'
  const out = renderMarkdown(raw)
  // 含 ANSI 转义 → 上了色
  expect(out).not.toBe(stripAnsi(out))
  // 文本本身保留
  expect(stripAnsi(out)).toContain('总结')
  expect(stripAnsi(out)).toContain('重点')
})
