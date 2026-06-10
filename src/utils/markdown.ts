// Markdown → ANSI terminal renderer
// 使用 marked 解析，chalk 渲染 ANSI 样式
// 策略对齐 claude-code-main/src/utils/markdown.ts + components/Markdown.tsx
import { marked, type Token, type Tokens } from 'marked'
import { Chalk } from 'chalk'
import chalk from 'chalk'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'

const EOL = '\n'

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
  return tokens.map(t => formatToken(t, c, 0)).join('')
}

function formatToken(token: Token, c: C, listDepth: number): string {
  switch (token.type) {
    case 'heading': {
      const inner = (token.tokens ?? []).map(t => formatToken(t, c, 0)).join('')
      // 标题统一上色（cyan），总结类标题（## 总结 / Summary）因此天然高亮突出。
      if (token.depth === 1) return c.bold.underline.cyan(inner) + EOL + EOL
      if (token.depth === 2) return c.bold.cyan(inner) + EOL + EOL
      return c.bold(inner) + EOL + EOL
    }

    case 'paragraph': {
      const inner = (token.tokens ?? []).map(t => formatToken(t, c, 0)).join('')
      return inner + EOL + EOL
    }

    case 'strong':
      // **重点** 用粗体黄色突出，便于扫读总结中的关键信息。
      return c.bold.yellow((token.tokens ?? []).map(t => formatToken(t, c, 0)).join(''))

    case 'em':
      return c.italic((token.tokens ?? []).map(t => formatToken(t, c, 0)).join(''))

    case 'codespan':
      return c.cyan(token.text)

    case 'code':
      return (
        c.dim('```' + (token.lang ?? '')) +
        EOL +
        c.yellow(token.text) +
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
      const items = (token as Tokens.List).items.map((item: Tokens.ListItem, i: number) => {
        const bullet = token.ordered
          ? c.bold(`${i + 1}.`)
          : c.bold(listDepth === 0 ? '•' : '◦')
        const indent = '  '.repeat(listDepth)
        const inner = (item.tokens ?? []).map((t: Token) => formatToken(t, c, listDepth + 1)).join('').trimEnd()
        return `${indent}${bullet} ${inner}`
      })
      return items.join(EOL) + EOL + EOL
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
      // 列宽按"可见宽度"计算（去 ANSI 后用 stringWidth，CJK 全角算 2 列），
      // 否则中文表格会错位。最小列宽 3。
      const widths = tbl.header.map((h, i) => {
        let w = stringWidth(stripAnsi(render(h.tokens)))
        for (const row of tbl.rows) {
          w = Math.max(w, stringWidth(stripAnsi(render(row[i]?.tokens))))
        }
        return Math.max(w, 3)
      })

      const renderRow = (cells: { tokens?: Token[] }[], bold: boolean) => {
        let line = c.dim('│')
        cells.forEach((cell, i) => {
          const raw = render(cell.tokens)
          const visible = stringWidth(stripAnsi(raw))
          const styled = bold ? c.bold.cyan(raw) : raw
          const padded = padAligned(styled, visible, widths[i]!, tbl.align?.[i])
          line += ' ' + padded + ' ' + c.dim('│')
        })
        return line
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
