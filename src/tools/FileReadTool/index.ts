// 文件读取工具 — 只读，支持行范围
// 参考源码: claude-code-main/packages/builtin-tools/src/tools/FileReadTool/
import { buildTool } from '../Tool'
import type { Tool, ToolCallResult } from '../Tool'
import { recordRead } from '../readFileState'

export const FileReadTool = buildTool({
  name: 'Read',
  description:
    'Read the contents of a file. Optionally specify line offset and limit to read a specific range.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or relative path to the file',
      },
      offset: {
        type: 'number',
        description: '1-based line number to start reading from (optional)',
      },
      limit: {
        type: 'number',
        description: 'Number of lines to read (optional)',
      },
    },
    required: ['file_path'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const filePath = input['file_path'] as string
    const offset = (input['offset'] as number | undefined) ?? 1
    const limit = input['limit'] as number | undefined

    try {
      const file = Bun.file(filePath)
      const exists = await file.exists()
      if (!exists) {
        return { output: `File not found: ${filePath}`, isError: true }
      }

      const text = await file.text()
      const lines = text.split('\n')

      const startIdx = Math.max(0, offset - 1)
      const endIdx = limit !== undefined ? startIdx + limit : lines.length

      const slice = lines.slice(startIdx, endIdx)
      // 加行号前缀（参考源码的 cat -n 风格）
      const numbered = slice.map((line, i) => `${startIdx + i + 1}\t${line}`).join('\n')

      // 记录本次读取：是否为部分读取（有 limit 或 offset > 1）
      const isPartial = limit !== undefined || offset > 1
      recordRead(filePath, isPartial)

      return { output: numbered }
    } catch (err: unknown) {
      return { output: String(err), isError: true }
    }
  },

  renderResult(input, output, isError) {
    if (isError) return null
    const filePath = input['file_path'] as string
    const lineCount = output.split('\n').length
    return [`Read ${lineCount} lines ← ${filePath}`]
  },
})
