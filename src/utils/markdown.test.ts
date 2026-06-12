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

test('wraps wide tables to fit the terminal so lines never overflow', () => {
  const md = [
    '| 场景 | marketplace.json 是否同步 | 用户能装新插件吗 |',
    '|------|------|------|',
    '| 新安装某个 marketplace（刚物化） | ✅ 同步（来源 repo 的快照一致） | 能 |',
    '| 远程 repo 新增了插件，本地已物化但未更新 | ❌ 不同步 | 不能 |',
  ].join('\n')

  const original = process.stdout.columns
  try {
    for (const cols of [120, 80, 60, 40]) {
      ;(process.stdout as { columns: number }).columns = cols
      const out = renderMarkdown(md)
      const lineWidths = stripAnsi(out)
        .split('\n')
        .map(l => stringWidth(l))
      // 任何一行（含内容行）的可见宽度都不得超过终端宽度，否则 Ink 会折行打散竖线。
      expect(Math.max(...lineWidths)).toBeLessThanOrEqual(cols)
      // 列仍然对齐：三条边框等宽。
      const widths = borderWidths(out)
      expect(widths.length).toBe(3)
      expect(new Set(widths).size).toBe(1)
    }
  } finally {
    ;(process.stdout as { columns: number | undefined }).columns = original
  }
})

test('emphasizes headings and bold text with weight (ANSI present)', () => {
  const raw = '## 总结\n\n**重点**：完成'
  const out = renderMarkdown(raw)
  // 含 ANSI 转义 → 加了样式（字重）
  expect(out).not.toBe(stripAnsi(out))
  // 文本本身保留
  expect(stripAnsi(out)).toContain('总结')
  expect(stripAnsi(out)).toContain('重点')
})

// ── Stage 2：CC 式单色+字重调色 ──────────────────────────────────────────────
test('palette: 标题与粗体只用字重，不再上 cyan/yellow', () => {
  const heading = renderMarkdown('## 总结')
  expect(heading).toContain('\x1b[1m')        // 加粗
  expect(heading).not.toContain('\x1b[36m')   // 无 cyan
  const strong = renderMarkdown('**重点**')
  expect(strong).toContain('\x1b[1m')         // 加粗
  expect(strong).not.toContain('\x1b[33m')    // 无 yellow
})

test('palette: 行内代码保留唯一强调色 cyan', () => {
  const out = renderMarkdown('用 `bun test` 跑')
  expect(out).toContain('\x1b[36m')           // codespan 仍 cyan
})

// ── Stage 2：扩展 markdown 覆盖 ──────────────────────────────────────────────
test('coverage: 删除线 ~~x~~ 渲染，单个 ~ 不误伤', () => {
  const out = renderMarkdown('done ~~old~~ new')
  expect(out).toContain('\x1b[9m')            // strikethrough
  expect(stripAnsi(out)).toContain('old')
  const approx = renderMarkdown('approx ~100 to ~200')
  expect(approx).not.toContain('\x1b[9m')     // 单 ~ 不触发 del
  expect(stripAnsi(approx)).toContain('~100')
})

test('coverage: 任务列表渲染 ☐/☑', () => {
  const out = stripAnsi(renderMarkdown('- [ ] todo\n- [x] done'))
  expect(out).toContain('☐ todo')
  expect(out).toContain('☑ done')
})

test('coverage: 嵌套列表各项独占一行且按深度缩进', () => {
  const out = stripAnsi(renderMarkdown('- a\n  - b\n    - c'))
  const lines = out.split('\n').filter(l => l.trim())
  expect(lines).toContain('• a')
  expect(lines.some(l => /^ {2}◦ b$/.test(l))).toBe(true)
  expect(lines.some(l => /^ {4}◦ c$/.test(l))).toBe(true)
})

test('spacing: 渲染结果不留尾部空行', () => {
  const out = renderMarkdown('一段话\n\n## 标题')
  expect(out).toBe(out.replace(/\n+$/, ''))
})
