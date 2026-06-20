// 工具头里的文件路径显示规则（grill 决议，trace 4 修复）。
//
//   · 文件在当前工作区（cwd）下 → 压成相对路径（README.md / src/ui/App.tsx），最直观。
//   · 文件在工作区之外 → 用绝对路径（相对路径会退化成 ../../.. 反而更难读）。
//   · 过长 → 中间省略（保留头部目录线索 + 文件名），绝不从中间硬折断工具名/路径。
//
// 输出永远是单行、可截断的字符串，交给调用方放进 wrap='truncate-end' 的 <Text>。

import { relative, isAbsolute } from 'node:path'
import { stringDisplayWidth } from './termWidth'

// 把一行按显示宽度做「中间省略」：保留首尾、中间塞 …，让人既看得到目录前缀又看得到文件名。
function middleEllipsis(s: string, max: number): string {
  if (stringDisplayWidth(s) <= max || max < 5) return s
  // 头尾各留一半（给 … 留 1 列）
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return s.slice(0, head) + '…' + s.slice(s.length - tail)
}

// 绝对路径 → 展示路径。cwd 下用相对，cwd 外用绝对；超过 max 列做中间省略。
export function displayPath(absPath: string, max = 72): string {
  let shown = absPath
  if (isAbsolute(absPath)) {
    const rel = relative(process.cwd(), absPath)
    // rel 不往上跳（不以 .. 开头）且非空 → 在工作区内，用相对路径。
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      shown = rel
    }
  }
  return middleEllipsis(shown, max)
}
