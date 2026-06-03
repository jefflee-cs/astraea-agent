// GrepTool — 文件内容正则搜索（封装 ripgrep）
// 参考: astraea-trace-and-build / GrepTool 教学文档
//
// 三种输出模式:
//   files_with_matches — 返回匹配的文件路径列表（按 mtime 排序）
//   content            — 返回匹配行的内容
//   count              — 返回每个文件的匹配计数
//
// 设计要点:
//   - 参数数组而非字符串拼接，防止 shell 注入
//   - 默认 250 条 head_limit 保护上下文窗口
//   - files_with_matches 模式按 mtime 降序排列（最近修改最相关）
//   - 条件字段输出：仅在截断时携带 appliedLimit，零信息字段不出现

import { resolve, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { buildTool } from '../Tool'
import type { Tool, ToolCallResult } from '../Tool'

// INTENT: 默认 250 条限制来自上下文窗口预算分析
// content 模式下 250 行约 2000-5000 token，是单次工具调用的合理上限
const DEFAULT_HEAD_LIMIT = 250

// INTENT: VCS 目录统一排除，避免 .git/ 内容污染搜索结果
const VCS_DIRS = ['.git', '.svn', '.hg', '.bzr', '_darcs']

// INTENT: ripgrep 路径，优先系统 PATH，macOS Homebrew 后备
function getRipgrepPath(): string {
  for (const p of [
    'rg',
    '/opt/homebrew/bin/rg',
    '/usr/local/bin/rg',
    '/usr/bin/rg',
  ]) {
    try {
      const r = spawnSync(p, ['--version'], { encoding: 'utf8' })
      if (r.status === 0) return p
    } catch { /* try next */ }
  }
  return 'rg'
}

const RG_PATH = getRipgrepPath()

function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset = 0,
): { items: T[]; truncated: boolean; appliedLimit?: number } {
  const effective = limit ?? DEFAULT_HEAD_LIMIT
  const sliced = items.slice(offset, offset + effective)
  return {
    items: sliced,
    truncated: sliced.length < items.length - offset,
    appliedLimit: sliced.length < items.length - offset ? effective : undefined,
  }
}

export const GrepTool = buildTool({
  name: 'Grep',
  description: `Search file contents using ripgrep. Supports three output modes:
- files_with_matches (default): list of matching file paths, sorted by modification time (most recent first)
- content: matching lines with context
- count: number of matches per file

Examples:
  pattern="TODO"                          → all files containing TODO
  pattern="export.*Tool" type="ts"       → TypeScript files exporting Tool
  pattern="isReadOnly" output="content"  → show matching lines`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern to search for (ripgrep syntax)',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search (default: cwd)',
      },
      output: {
        type: 'string',
        enum: ['files_with_matches', 'content', 'count'],
        description: 'Output mode (default: files_with_matches)',
      },
      case_sensitive: {
        type: 'boolean',
        description: 'Case-sensitive search (default: false)',
      },
      type: {
        type: 'string',
        description: 'File type filter, e.g. "ts", "py", "json" (ripgrep --type)',
      },
      head_limit: {
        type: 'number',
        description: `Max results to return (default: ${DEFAULT_HEAD_LIMIT})`,
      },
    },
    required: ['pattern'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const pattern      = input['pattern']        as string
    const searchPath   = input['path']           as string | undefined
    const outputMode   = (input['output']        as string | undefined) ?? 'files_with_matches'
    const caseSens     = (input['case_sensitive'] as boolean | undefined) ?? false
    const fileType     = input['type']           as string | undefined
    const headLimit    = input['head_limit']     as number | undefined

    const cwd = process.cwd()
    const basePath = searchPath ? resolve(cwd, searchPath) : cwd

    // ── 构建 ripgrep 参数 ───────────────────────────────────────────
    const args: string[] = ['--no-heading', '--no-messages']
    if (!caseSens) args.push('--ignore-case')
    if (fileType)  args.push('--type', fileType)
    for (const d of VCS_DIRS) args.push('--glob', `!${d}`)

    if (outputMode === 'files_with_matches') {
      args.push('--files-with-matches')
    } else if (outputMode === 'count') {
      args.push('--count')
    } else {
      args.push('--line-number')
    }

    args.push('--', pattern, basePath)

    // ── 执行 ripgrep ───────────────────────────────────────────────
    const result = spawnSync(RG_PATH, args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })

    if (result.error) {
      return { output: `ripgrep not found: ${result.error.message}`, isError: true }
    }

    const stdout = result.stdout ?? ''
    const lines  = stdout.split('\n').filter(Boolean)

    if (lines.length === 0) {
      return { output: `No matches found for: ${pattern}` }
    }

    // ── 输出格式化 ────────────────────────────────────────────────
    if (outputMode === 'files_with_matches') {
      // 按 mtime 降序排（最近修改的文件最相关）
      const withMtime = lines.map(f => {
        try { return { f, mt: statSync(f).mtimeMs } } catch { return { f, mt: 0 } }
      })
      withMtime.sort((a, b) => b.mt - a.mt)
      const sorted = withMtime.map(x => relative(cwd, x.f) || x.f)
      const { items, truncated, appliedLimit } = applyHeadLimit(sorted, headLimit)
      const suffix = truncated ? `\n(truncated at ${appliedLimit} results)` : ''
      return { output: items.join('\n') + suffix }
    }

    const { items, truncated, appliedLimit } = applyHeadLimit(lines, headLimit)
    const suffix = truncated ? `\n(truncated at ${appliedLimit} results)` : ''
    return { output: items.join('\n') + suffix }
  },
})
