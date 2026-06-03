// 文件路径搜索工具 — glob 模式匹配
// 参考: astraea-trace-and-build / GlobTool 教学文档
//
// 设计要点：
//   - 使用 Bun.Glob 内置实现，无需额外依赖
//   - 结果上限 100 条 + truncated 透明告知，防止大型仓库淹没 LLM 上下文
//   - 返回相对于搜索根目录的路径，节省 token
//   - 路径验证在执行前完成，早期失败
import { resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { buildTool } from '../Tool'
import type { Tool, ToolCallResult } from '../Tool'

const MAX_RESULTS = 100

export const GlobTool = buildTool({
  name: 'Glob',
  description: `Find files matching a glob pattern. Returns sorted relative paths, up to 100 results.

Usage:
  pattern="**/*.ts"           → all TypeScript files recursively
  pattern="src/**/*.test.ts"  → test files under src/
  pattern="*.json"            → JSON files in root only
  path="src/"                 → restrict search to src/ subdirectory

If results are truncated, use a more specific pattern or narrow the search path.`,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern (e.g. **/*.ts, src/**/*.test.js)',
      },
      path: {
        type: 'string',
        description: 'Directory to search in (default: current working directory)',
      },
    },
    required: ['pattern'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const pattern = input['pattern'] as string
    const searchPath = input['path'] as string | undefined

    const basePath = searchPath ? resolve(searchPath) : process.cwd()

    // ── 路径验证（早期失败，避免无效搜索）────────────────────────────────
    if (searchPath) {
      if (!existsSync(basePath)) {
        return { output: `Directory does not exist: ${searchPath}`, isError: true }
      }
      let isDir: boolean
      try {
        isDir = statSync(basePath).isDirectory()
      } catch (err: unknown) {
        return { output: `Cannot access path: ${searchPath} — ${err}`, isError: true }
      }
      if (!isDir) {
        return { output: `Path is not a directory: ${searchPath}`, isError: true }
      }
    }

    // ── 执行 glob 搜索 ────────────────────────────────────────────────────
    const start = Date.now()

    try {
      const glob = new Bun.Glob(pattern)
      const files: string[] = []
      let truncated = false

      // dot: true — 包含以 . 开头的隐藏文件/目录（与原版行为一致）
      for await (const file of glob.scan({ cwd: basePath, onlyFiles: true, dot: true })) {
        if (files.length >= MAX_RESULTS) {
          truncated = true
          break
        }
        files.push(file)
      }

      files.sort()

      const durationMs = Date.now() - start

      if (files.length === 0) {
        const stem = pattern
          .replace(/^(\*\*\/)*/, '')   // strip leading **/
          .replace(/\.[^.]*$/, '')     // strip extension
          .replace(/[*?[\]{}]/g, '')   // strip glob chars
          .trim()
        const suggestion = stem.length > 0
          ? `\nHint: If you assumed the filename, try a broader pattern first — e.g. Glob(**/*${stem}*) to discover the actual name and extension.`
          : ''
        return { output: `No files found${suggestion}` }
      }

      // ── 透明截断告知：结果不完整时明确提示 LLM ───────────────────────
      const lines = [...files]
      if (truncated) {
        lines.push('(Results are truncated. Consider using a more specific path or pattern.)')
      }

      return {
        output: `${lines.join('\n')}\n\n${files.length} file${files.length === 1 ? '' : 's'} found in ${durationMs}ms${truncated ? ' (truncated)' : ''}`,
      }
    } catch (err: unknown) {
      return { output: `Glob error: ${err}`, isError: true }
    }
  },
})
