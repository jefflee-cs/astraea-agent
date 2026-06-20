// 代码改动的"IDE 暗主题背景带"渲染 —— Edit 的 +/- diff 与 Write 的新建预览共用。
//
// 设计（见 UI grill 决议）：
//   · 添加行走深森绿背景带，删除行走深褐红背景带；整行满宽（铺到终端右缘）。
//   · 行内文字白色；行内代码注释（// # /* */ <!-- --> 等）保持灰色。
//   · 注释检测：按文件扩展名取注释语法，跳过字符串字面量内的标记（避免 http:// 被误判）。
//   · 暗调深色带 → 白字与灰注释在带上都清晰可读。
//
// 数据流：本模块产出"自带 ANSI 样式的整行字符串"，由 ToolBatch 的 ResultLines 原样打印
// （检测到内嵌 ESC 即不再二次上色）。因此 Tool.renderResult 的 string[] 契约不变。

import { Chalk } from 'chalk'
import chalk from 'chalk'
import stringWidth from 'string-width'

// ── 色板（grill 决议：深森绿 / 深褐红）──────────────────────────────────────
const ADD_BG = '#143321'   // 深森绿 —— 添加行背景
const DEL_BG = '#3A1A1E'   // 深褐红 —— 删除行背景
const TEXT = '#E8E8E8'     // 近白 —— 代码正文
const COMMENT = '#7A8AAA'  // 品牌蓝灰（DIM）—— 行内注释
const MARKER = '#FFFFFF'   // 亮白 —— +/- 标记

// 强制输出 ANSI（Ink 接管终端时 isTTY 可能探测不到），与 markdown.ts 同策略。
const c = new Chalk({ level: chalk.level > 0 ? chalk.level : 3 })

export interface CommentSyntax {
  line: string[]                      // 行注释起始标记（到行尾）
  block: Array<[string, string]>      // 块注释 [开, 闭]（仅单行内）
}

// 扩展名 → 注释语法。未登记的扩展名返回 null（不做注释灰化，整行白字）。
const BY_EXT: Record<string, CommentSyntax> = {}
function reg(exts: string[], syntax: CommentSyntax) {
  for (const e of exts) BY_EXT[e] = syntax
}

const SLASH: CommentSyntax = { line: ['//'], block: [['/*', '*/']] }
reg(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx',
     'cs', 'java', 'go', 'rs', 'swift', 'kt', 'kts', 'scala', 'php', 'dart',
     'm', 'mm', 'zig', 'v'], SLASH)
reg(['scss', 'less', 'sass', 'styl'], { line: ['//'], block: [['/*', '*/']] })
reg(['css'], { line: [], block: [['/*', '*/']] })
reg(['py', 'rb', 'sh', 'bash', 'zsh', 'fish', 'yaml', 'yml', 'toml', 'ini', 'cfg',
     'conf', 'r', 'pl', 'pm', 'tcl', 'nim', 'cr', 'makefile', 'dockerfile'],
    { line: ['#'], block: [] })
reg(['lua', 'sql', 'hs', 'elm', 'ada', 'adb'], { line: ['--'], block: [] })
reg(['lisp', 'clj', 'cljs', 'cljc', 'el', 'scm', 'ss', 'rkt'], { line: [';'], block: [] })
reg(['html', 'htm', 'xml', 'vue', 'svelte', 'md', 'markdown', 'svg'],
    { line: [], block: [['<!--', '-->']] })

// 取文件的注释语法：先按扩展名，再退回无扩展名文件名（Makefile/Dockerfile）。
export function commentSyntaxFor(filePath: string): CommentSyntax | null {
  const base = (filePath.split('/').pop() ?? filePath).toLowerCase()
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base
  return BY_EXT[ext] ?? null
}

export interface Segment { text: string; kind: 'code' | 'comment' }

// 把一行代码切成 code / comment 段：扫描字符，跟踪字符串状态，串内的标记不算注释。
export function splitCodeComment(code: string, syntax: CommentSyntax): Segment[] {
  const segments: Segment[] = []
  let buf = ''
  let inString = false
  let quote = ''
  const flush = () => { if (buf) { segments.push({ text: buf, kind: 'code' }); buf = '' } }

  let i = 0
  while (i < code.length) {
    const ch = code[i]!
    if (inString) {
      buf += ch
      if (ch === '\\' && i + 1 < code.length) { buf += code[i + 1]; i += 2; continue }  // 转义
      if (ch === quote) inString = false
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true; quote = ch; buf += ch; i++; continue
    }
    // 行注释 → 到行尾全为注释
    const lineMk = syntax.line.find(m => code.startsWith(m, i))
    if (lineMk) {
      flush()
      segments.push({ text: code.slice(i), kind: 'comment' })
      return segments
    }
    // 块注释（仅单行内）→ 找同行闭合；找不到则视该行剩余为注释（本行起始的块）
    const blk = syntax.block.find(([open]) => code.startsWith(open, i))
    if (blk) {
      const [open, close] = blk
      const closeIdx = code.indexOf(close, i + open.length)
      flush()
      if (closeIdx !== -1) {
        const end = closeIdx + close.length
        segments.push({ text: code.slice(i, end), kind: 'comment' })
        i = end
        continue
      }
      segments.push({ text: code.slice(i), kind: 'comment' })
      return segments
    }
    buf += ch
    i++
  }
  flush()
  return segments
}

const GUTTER = '#6B7280'   // 行号沟（中性灰）
const GUTTER_GAP = '    '   // 行号与 +/- 标记之间的间隔（拉开距离，行号不贴着标记）

// 满宽带目标列宽：终端列 - (ResultLines 的 marginLeft 4 + 3 空格 gutter + 1 安全余量)。
// reserved 额外扣掉行号沟自身的宽度，保证「行号沟 + 背景带」整体不超宽、不触发折行。
function bandWidth(reserved = 0): number {
  const cols = process.stdout?.columns
  const n = typeof cols === 'number' && cols > 0 ? cols : 80
  return Math.max(20, n - 8 - reserved)
}

// 把一行内容渲染成「左侧行号沟 + 自带 ANSI 的满宽背景带」。
//   · gutter：右对齐的行号字符串（renderResult 算好传入）；空串表示不画沟。
//   · type='context'：未改动的上下文行，灰字、无背景带、对齐 +/- 标记位。
// content 不含 +/- 标记（本函数自绘标记）。
export function styleDiffLine(
  content: string,
  type: 'add' | 'remove' | 'context',
  filePath: string,
  gutter = '',
): string {
  // 行号沟：灰色行号 + GUTTER_GAP 间隔分隔（无行号时不占位）。
  const gut = gutter ? c.hex(GUTTER)(gutter) + GUTTER_GAP : ''
  const gutW = gutter ? stringWidth(gutter) + GUTTER_GAP.length : 0

  // 上下文行：不铺背景，灰字；前缀两个空格占住 +/- 标记位，使列对齐。
  if (type === 'context') {
    return gut + c.hex(COMMENT).dim('  ' + content)
  }

  const bg = type === 'add' ? ADD_BG : DEL_BG
  const marker = type === 'add' ? '+' : '-'
  const syntax = commentSyntaxFor(filePath)
  const segments: Segment[] = syntax
    ? splitCodeComment(content, syntax)
    : [{ text: content, kind: 'code' }]

  // 标记（亮白加粗）+ 空格，整段铺 bg。
  let out = c.bgHex(bg).hex(MARKER).bold(`${marker} `)
  let visible = 2
  for (const seg of segments) {
    out += seg.kind === 'comment'
      ? c.bgHex(bg).hex(COMMENT)(seg.text)
      : c.bgHex(bg).hex(TEXT)(seg.text)
    visible += stringWidth(seg.text)
  }
  // 补齐到满宽（短行铺满背景；长行不补，由 Ink 折行、bg 自然延续）。
  const target = bandWidth(gutW)
  if (visible < target) out += c.bgHex(bg)(' '.repeat(target - visible))
  return gut + out
}
