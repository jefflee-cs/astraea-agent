// Markdown → ANSI terminal renderer
// 使用 marked 解析，chalk 渲染 ANSI 样式
// 策略对齐 claude-code-main/src/utils/markdown.ts + components/Markdown.tsx
import { marked, type Token, type Tokens } from 'marked'
import { Chalk } from 'chalk'
import chalk from 'chalk'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'
import wrapAnsi from 'wrap-ansi'

const EOL = '\n'

// 终端可用列宽。Ink 把整段 markdown 放在贴边（marginLeft=0）的 <Text> 里，默认 wrap='wrap'，
// 一旦某行可见宽度超过这个值，Ink 就会硬折行，把表格的竖线打散。所以表格必须先把自己
// 限制在这个宽度内。留 1 列安全余量，规避正好顶边时的折行。管道/非 TTY 下退回 80。
function termWidth(): number {
  const cols = process.stdout?.columns
  return Math.max(20, (typeof cols === 'number' && cols > 0 ? cols : 80) - 1)
}

// 把列宽总和压到 maxContent 以内：每次从「最宽且仍高于 minW」的列削 1，直到达标或全部触底。
// 这样优先压缩冗长的列（通常是中文描述列），窄列尽量保住。
function fitColumnWidths(widths: number[], maxContent: number, minW: number): number[] {
  const w = [...widths]
  let budget = w.reduce((a, b) => a + b, 0) - maxContent
  while (budget > 0) {
    let idx = -1
    let max = minW
    for (let i = 0; i < w.length; i++) {
      if (w[i]! > max) { max = w[i]!; idx = i }
    }
    if (idx === -1) break // 全部已到下限，无法再压（极窄终端，容忍轻微溢出）
    w[idx]!--
    budget--
  }
  return w
}

// 把内容按可见宽度（CJK 全角占 2 列）补齐到 targetWidth，支持对齐。
// displayWidth 为 content 去掉 ANSI 后的可见宽度，避免颜色码影响补齐。
function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const left = Math.floor(padding / 2)
    return ' '.repeat(left) + content + ' '.repeat(padding - left)
  }
  if (align === 'right') return ' '.repeat(padding) + content
  return content + ' '.repeat(padding)
}

type C = InstanceType<typeof Chalk>

export function renderMarkdown(text: string): string {
  if (!text.trim()) return text
  // 强制 chalk 输出 ANSI（Ink 接管终端时 isTTY 可能未被探测到）
  const c: C = new Chalk({ level: chalk.level > 0 ? chalk.level : 3 })
  const tokens = marked.lexer(text)
  // 收尾去掉块级 token 累积的尾部空行 —— 配合外层 marginBottom，避免双重空行（紧凑层次）。
  return tokens.map(t => formatToken(t, c, 0)).join('').replace(/\n+$/, '')
}

function formatToken(token: Token, c: C, listDepth: number): string {
  switch (token.type) {
    case 'heading': {
      const inner = (token.tokens ?? []).map(t => formatToken(t, c, 0)).join('')
      // CC 式单色+字重：层级靠 下划线/字重 区分，不靠颜色（避免满屏 cyan）。
      // h1 加下划线最重，h2/h3+ 仅加粗（与 CC 一致）。
      if (token.depth === 1) return c.bold.underline(inner) + EOL + EOL
      return c.bold(inner) + EOL + EOL
    }

    case 'paragraph': {
      const inner = (token.tokens ?? []).map(t => formatToken(t, c, 0)).join('')
      return inner + EOL + EOL
    }

    case 'strong':
      // 单色：**重点** 仅加粗，不上色（对齐 CC 的克制风，靠字重而非颜色）。
      return c.bold((token.tokens ?? []).map(t => formatToken(t, c, 0)).join(''))

    case 'em':
      return c.italic((token.tokens ?? []).map(t => formatToken(t, c, 0)).join(''))

    case 'del':
      // 删除线（GFM ~~text~~）。单个 ~（如 ~100）不会触发 del，无误伤。
      return c.strikethrough((token.tokens ?? []).map(t => formatToken(t, c, 0)).join(''))

    case 'checkbox':
      // 复选框标记由 list 渲染统一画成 ☑/☐，token 本身不输出。
      return ''

    case 'codespan':
      // 行内代码：唯一保留的强调色（cyan 单一强调色，仅 code/链接使用）。
      return c.cyan(token.text)

    case 'code':
      // 代码块：dim 围栏 + 默认前景正文（去掉刺眼黄色，块级不铺色，对齐 CC）。
      return (
        c.dim('```' + (token.lang ?? '')) +
        EOL +
        token.text +
        EOL +
        c.dim('```') +
        EOL + EOL
      )

    case 'blockquote': {
      const inner = (token.tokens ?? []).map(t => formatToken(t, c, 0)).join('')
      return inner
        .split(EOL)
        .map(line => (line.trim() ? c.dim('│ ') + c.italic(line) : line))
        .join(EOL)
    }

    case 'list': {
      const list = token as Tokens.List
      const start = Number(list.start) || 1
      const lines: string[] = []
      list.items.forEach((item: Tokens.ListItem, i: number) => {
        const indent = '  '.repeat(listDepth)
        // 标记：任务项 → 复选框；有序 → 序号；无序 → 按深度切换 •/◦。
        const marker = item.task
          ? (item.checked ? c.dim('☑') : '☐')
          : c.bold(list.ordered ? `${start + i}.` : (listDepth === 0 ? '•' : '◦'))
        // 拆分行内内容与嵌套块：嵌套 list 必须另起行，否则会被粘到当前项同一行。
        const inlineParts: string[] = []
        const blockParts: string[] = []
        for (const t of (item.tokens ?? [])) {
          const tt = t.type as string
          if (tt === 'list') blockParts.push(formatToken(t, c, listDepth + 1))
          else if (tt === 'checkbox') continue  // 由 marker 统一处理，跳过避免重复
          else inlineParts.push(formatToken(t, c, listDepth + 1))
        }
        let text = inlineParts.join('').trimEnd()
        if (item.task && item.checked) text = c.dim(text)  // 已完成项整体 dim
        lines.push(`${indent}${marker} ${text}`)
        for (const b of blockParts) lines.push(b.replace(/\n+$/, ''))  // 嵌套块自带缩进，仅去尾空行
      })
      return lines.join(EOL) + EOL + EOL
    }

    case 'list_item': {
      return (token.tokens ?? []).map(t => formatToken(t, c, listDepth)).join('')
    }

    case 'hr':
      return c.dim('─'.repeat(40)) + EOL + EOL

    case 'link': {
      const inner = (token.tokens ?? []).map(t => formatToken(t, c, 0)).join('') || token.text
      return c.cyan.underline(inner)
    }

    case 'text':
      if ('tokens' in token && token.tokens) {
        return (token.tokens as Token[]).map(t => formatToken(t, c, 0)).join('')
      }
      return token.text ?? ''

    case 'br':
      return EOL

    case 'space':
      return EOL

    case 'table': {
      const tbl = token as Tokens.Table
      const render = (tokens: Token[] | undefined) =>
        (tokens ?? []).map(t => formatToken(t, c, 0)).join('')
      const MIN_W = 3
      const ncols = tbl.header.length

      // 自然列宽：按"可见宽度"计算（去 ANSI 后用 stringWidth，CJK 全角算 2 列），最小 3。
      const natural = tbl.header.map((h, i) => {
        let w = stringWidth(stripAnsi(render(h.tokens)))
        for (const row of tbl.rows) {
          w = Math.max(w, stringWidth(stripAnsi(render(row[i]?.tokens))))
        }
        return Math.max(w, MIN_W)
      })

      // 每行装饰开销 = 行首 │ + 每列(空格 + 内容 + 空格 + │) = 1 + 3*ncols。
      // 若自然总宽放不下，按可用内容宽收缩，让整表卡在终端宽度内 → Ink 不再折行打散竖线。
      const overhead = 1 + 3 * ncols
      const maxContent = termWidth() - overhead
      const naturalTotal = natural.reduce((a, b) => a + b, 0)
      const widths =
        naturalTotal <= maxContent || maxContent < ncols * MIN_W
          ? natural
          : fitColumnWidths(natural, maxContent, MIN_W)

      // 单元格内容按分配到的列宽做 ANSI 感知换行（CJK 宽度由 wrap-ansi 内部用 string-width 处理），
      // 一格可能折成多行；整行高度取各格最大行数，不足的格用空白补齐。
      const renderRow = (cells: { tokens?: Token[] }[], bold: boolean) => {
        const cellLines = tbl.header.map((_, i) => {
          const raw = render(cells[i]?.tokens)
          const wrapped = wrapAnsi(raw, widths[i]!, { hard: true, trim: false })
          return wrapped.length ? wrapped.split(EOL) : ['']
        })
        const height = Math.max(1, ...cellLines.map(l => l.length))
        const out: string[] = []
        for (let r = 0; r < height; r++) {
          let line = c.dim('│')
          for (let i = 0; i < ncols; i++) {
            const cellLine = cellLines[i]![r] ?? ''
            const visible = stringWidth(stripAnsi(cellLine))
            const styled = bold ? c.bold(cellLine) : cellLine  // 表头单色加粗（去 cyan）
            const padded = padAligned(styled, visible, widths[i]!, tbl.align?.[i])
            line += ' ' + padded + ' ' + c.dim('│')
          }
          out.push(line)
        }
        return out.join(EOL)
      }

      const border = (left: string, mid: string, right: string) =>
        c.dim(left + widths.map(w => '─'.repeat(w + 2)).join(mid) + right)

      const lines = [
        border('┌', '┬', '┐'),
        renderRow(tbl.header, true),
        border('├', '┼', '┤'),
        ...tbl.rows.map(row => renderRow(row, false)),
        border('└', '┴', '┘'),
      ]
      return lines.join(EOL) + EOL + EOL
    }

    default:
      return (token as { text?: string }).text ?? (token as { raw?: string }).raw ?? ''
  }
}
