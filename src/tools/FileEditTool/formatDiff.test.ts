import { test, expect } from 'bun:test'
import { formatDiff } from './utils'

test('formatDiff emits a unified hunk header with correct line ranges', () => {
  const oldF = ['a', 'b', 'target', 'c', 'd'].join('\n')
  const newF = ['a', 'b', 'X', 'Y', 'c', 'd'].join('\n')
  const diff = formatDiff(oldF, newF)
  const lines = diff.split('\n')
  // 变更在第 3 行（index 2），上下文 3 行 → hunk 从第 1 行起。
  expect(lines[0]).toMatch(/^@@ -1,\d+ \+1,\d+ @@$/)
})

test('formatDiff keeps context lines (space prefix) around the change', () => {
  const oldF = ['l1', 'l2', 'l3', 'OLD', 'l5', 'l6', 'l7'].join('\n')
  const newF = ['l1', 'l2', 'l3', 'NEW', 'l5', 'l6', 'l7'].join('\n')
  const body = formatDiff(oldF, newF).split('\n').slice(1)
  expect(body).toContain(' l3')   // 前置上下文
  expect(body).toContain('-OLD')  // 删除
  expect(body).toContain('+NEW')  // 新增
  expect(body).toContain(' l5')   // 后置上下文
  // 上下文裁到 3 行：l1 之前不应出现（l1 距变更 >3 行的话）。此例 l1 距变更 2 行，保留。
})

test('formatDiff caps context at 3 lines on each side', () => {
  const oldLines = Array.from({ length: 12 }, (_, i) => `line${i}`)
  const newLines = [...oldLines]
  newLines[6] = 'CHANGED'
  const body = formatDiff(oldLines.join('\n'), newLines.join('\n')).split('\n').slice(1)
  // 变更在 index 6；上下文 3 行 → 含 line3..line5（前）、line7..line9（后），不含 line2 / line10。
  expect(body).toContain(' line3')
  expect(body).not.toContain(' line2')
  expect(body).toContain(' line9')
  expect(body).not.toContain(' line10')
})

test('formatDiff returns empty string when nothing changed', () => {
  expect(formatDiff('same\ntext', 'same\ntext')).toBe('')
})

test('formatDiff handles multi-line insertions (more new than old)', () => {
  const oldF = ['head', 'one', 'tail'].join('\n')
  const newF = ['head', 'one-a', 'one-b', 'one-c', 'tail'].join('\n')
  const body = formatDiff(oldF, newF).split('\n').slice(1)
  expect(body.filter(l => l.startsWith('-'))).toEqual(['-one'])
  expect(body.filter(l => l.startsWith('+'))).toEqual(['+one-a', '+one-b', '+one-c'])
})
