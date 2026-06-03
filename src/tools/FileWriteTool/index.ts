// 文件写入工具 — 创建或覆盖文件
// 参考源码: claude-code-main/packages/builtin-tools/src/tools/FileWriteTool/
//
// 安全保障（对齐原版 validateInput）：
//   1. 写前必须读：文件已存在但从未被 Read → 拒绝，防止盲目覆盖
//   2. mtime 守卫：读后文件被外部修改 → 拒绝，要求重新读
import { buildTool } from '../Tool'
import type { Tool, ToolCallResult, ToolContext } from '../Tool'
import { validateWrite, recordWrite } from '../readFileState'
import { checkWritePermission } from '../fileWriteGate'

export const FileWriteTool = buildTool({
  name: 'Write',
  description: `Write content to a file, creating it if it does not exist and overwriting it if it does.
Use this instead of echo redirection or cat heredoc in Bash.
Always use absolute paths.
IMPORTANT: If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.`,
  isReadOnly: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to write',
      },
      content: {
        type: 'string',
        description: 'The full content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  },

  async call(input, ctx: ToolContext): Promise<ToolCallResult> {
    const filePath = input['file_path'] as string
    const content  = input['content']   as string

    // ── 权限闸：模式取向 + 红线 + 交互/fail-closed（§1.3 / §5 / §3.0）──────
    const gate = await checkWritePermission(filePath, ctx, 'write')
    if (!gate.proceed) {
      return { output: gate.rejection!, isError: true }
    }

    // ── 安全校验：写前必须读 + mtime 守卫 ────────────────────────────────
    const rejection = validateWrite(filePath)
    if (rejection) {
      return { output: rejection, isError: true }
    }

    // ── 写入 ──────────────────────────────────────────────────────────────
    try {
      await Bun.write(filePath, content)
      // 写后更新 readFileState，避免连续写入时被自己的 mtime 变化误判
      recordWrite(filePath)
      return { output: `Written: ${filePath}` }
    } catch (err: unknown) {
      return { output: String(err), isError: true }
    }
  },

  renderResult(input, _output, isError) {
    if (isError) return null
    const filePath = input['file_path'] as string
    const content = input['content'] as string
    const allLines = content.split('\n')
    const lineCount = allLines.length
    const preview = allLines.slice(0, 6).map(l => `  ${l}`)
    const truncated = lineCount > 6 ? [...preview, `  … (${lineCount - 6} more lines)`] : preview
    return [`Written ${lineCount} lines → ${filePath}`, ...truncated]
  },
})
