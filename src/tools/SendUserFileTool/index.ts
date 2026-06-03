import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  return `${(bytes / 1024).toFixed(1)} KB`
}
export const SendUserFileTool = buildTool({
  name: 'SendUserFile',
  description: `Deliver a local file to the user by displaying its path and metadata.
Use after generating a report or summary file so the user can easily locate it.

file_path must be an absolute path to an existing readable file.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      file_path:   { type: 'string', description: 'Absolute path to the file to deliver' },
      description: { type: 'string', description: 'Optional label shown alongside the file' },
    },
    required: ['file_path'],
  },

  async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolCallResult> {
    const filePath = String(input['file_path'] ?? '').trim()
    const description = input['description'] ? String(input['description']) : undefined

    if (!filePath) return { output: 'file_path is required.', isError: true }

    if (!isAbsolute(filePath)) {
      return { output: `file_path 必须是绝对路径，收到的是："${filePath}"`, isError: true }
    }

    if (!existsSync(filePath)) {
      return { output: `文件不存在：${filePath}`, isError: true }
    }

    const stat = statSync(filePath)
    const name = basename(filePath)
    const size = formatBytes(stat.size)

    const lines = ['📄 文件已就绪']
    if (description) lines.push(`   ${description}`)
    lines.push(`   名称：${name}`)
    lines.push(`   路径：${filePath}`)
    lines.push(`   大小：${size}`)

    return { output: lines.join('\n') }
  },
})
