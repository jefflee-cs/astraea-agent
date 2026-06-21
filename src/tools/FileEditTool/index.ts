// 文件精确编辑工具 — 字符串替换式编辑（String Replace Edit）
// 参考: astraea-trace-and-build / FileEditTool 教学文档
//
// 核心不变量：
//   1. 写前必须读（read-before-write）：通过 readFileState 强制
//   2. 时间戳守卫：读后文件被外部修改时拒绝写入
//   3. 透明引号规范化：弯/直引号差异不影响匹配
//   4. 多处匹配保护：replace_all=false 时唯一匹配才允许替换
import { resolve, dirname } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { buildTool } from '../Tool'
import type { Tool, ToolCallResult, ToolContext } from '../Tool'
import { validateWrite, recordWrite } from '../readFileState'
import { checkWritePermission } from '../fileWriteGate'
import { findActualString, preserveQuoteStyle, applyEdit, formatDiff } from './utils'
import { styleDiffLine } from '../diffStyle'
import { displayPath } from '../../utils/displayPath'
import { captureFile } from '../../services/rewind/checkpointStore'

export const FileEditTool = buildTool({
  name: 'Edit',
  description: `Perform exact string-replacement edits on a file. More efficient than rewriting the whole file.

You MUST use the Read tool to read the file before calling Edit on an existing file.

Parameters:
- file_path: Absolute path to the file
- old_string: The exact text to replace (must appear exactly once unless replace_all is true).
  Use empty string ("") to create a new file.
  Include 1-2 lines of surrounding context to ensure uniqueness.
- new_string: The replacement text
- replace_all: Replace every occurrence (default false). When false, old_string must be unique.

Common patterns:
  Edit existing code → old_string=target+context, new_string=modified version
  Add to file end   → old_string=last few lines, new_string=those lines + new content
  Delete a line     → old_string=line+next line, new_string=next line only
  Create new file   → old_string="", new_string=full file content`,

  isReadOnly: () => false,

  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to edit',
      },
      old_string: {
        type: 'string',
        description:
          'Text to replace. Must uniquely identify the location (include surrounding context). Empty string to create a new file.',
      },
      new_string: {
        type: 'string',
        description: 'Replacement text',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences of old_string (default: false)',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },

  async call(input, ctx: ToolContext): Promise<ToolCallResult> {
    const filePath = input['file_path'] as string
    const oldString = input['old_string'] as string
    const newString = input['new_string'] as string
    const replaceAll = (input['replace_all'] as boolean | undefined) ?? false

    const absolutePath = resolve(filePath)

    // ── 无效编辑早期拒绝 ─────────────────────────────────────────────────────
    if (oldString === newString) {
      return {
        output: 'old_string and new_string are identical — no edit needed.',
        isError: true,
      }
    }

    // ── 权限闸：模式取向 + 红线 + 交互/fail-closed（§1.3 / §5 / §3.0）──────
    const gate = await checkWritePermission(absolutePath, ctx, 'edit')
    if (!gate.proceed) {
      return { output: gate.rejection!, isError: true }
    }

    const fileExists = existsSync(absolutePath)

    // ── 创建新文件：old_string 为空 + 文件不存在 ─────────────────────────────
    if (oldString === '' && !fileExists) {
      try {
        captureFile(absolutePath) // /rewind：新建文件 → 记 null 前态（回滚即删除）
        mkdirSync(dirname(absolutePath), { recursive: true })
        writeFileSync(absolutePath, newString, 'utf8')
        recordWrite(absolutePath)
        return { output: `Created: ${filePath}` }
      } catch (err: unknown) {
        return { output: `Failed to create file: ${err}`, isError: true }
      }
    }

    // ── 文件已存在但 old_string 为空：拒绝（应用 Write 工具或提供 old_string）
    if (oldString === '' && fileExists) {
      return {
        output:
          'old_string is empty but the file already exists. Use the Write tool to overwrite the whole file, or provide a non-empty old_string to identify the edit location.',
        isError: true,
      }
    }

    // ── 文件不存在且 old_string 非空：拒绝 ──────────────────────────────────
    if (!fileExists) {
      return { output: `File not found: ${filePath}`, isError: true }
    }

    // ── 读-写状态约束：必须先用 Read 读取，且读后文件未被外部修改 ────────────
    // validateWrite 同时检查：① 是否曾读过 ② 是否只读了部分 ③ mtime 是否变化
    const writeCheck = validateWrite(absolutePath)
    if (writeCheck) {
      return { output: writeCheck, isError: true }
    }

    // ── 原子区：同步读取，避免 validate 和 write 之间的 TOCTOU 窗口 ──────────
    // 此处开始到 writeFileSync 之间全为同步操作，无 await yield 点
    let fileContents: string
    try {
      fileContents = readFileSync(absolutePath, 'utf8')
    } catch (err: unknown) {
      return { output: `Failed to read file: ${err}`, isError: true }
    }

    // ── 引号规范化匹配：LLM 直引号 vs 文件弯引号透明处理 ────────────────────
    const actualOldString = findActualString(fileContents, oldString)
    if (actualOldString === null) {
      const preview = oldString.length > 80 ? oldString.slice(0, 80) + '…' : oldString
      return {
        output: `String not found in file: ${JSON.stringify(preview)}\n\nTip: copy the exact text from the Read tool output, including surrounding whitespace.`,
        isError: true,
      }
    }

    // ── 多处匹配保护：replace_all=false 时必须唯一 ──────────────────────────
    if (!replaceAll) {
      const matchCount = fileContents.split(actualOldString).length - 1
      if (matchCount > 1) {
        return {
          output: `Found ${matchCount} occurrences of the target string. Provide more surrounding context to uniquely identify the location, or set replace_all to true if you want all replaced.`,
          isError: true,
        }
      }
    }

    // ── 保持文件原有引号风格，执行替换 ──────────────────────────────────────
    const actualNewString = preserveQuoteStyle(oldString, actualOldString, newString)
    const updatedFile = applyEdit(fileContents, actualOldString, actualNewString, replaceAll)

    // ── 写入文件（同步，原子区结束）──────────────────────────────────────────
    try {
      captureFile(absolutePath) // /rewind copy-on-write：记录改动前态（写盘前一刻）
      writeFileSync(absolutePath, updatedFile, 'utf8')
    } catch (err: unknown) {
      return { output: `Failed to write file: ${err}`, isError: true }
    }

    // ── 写后更新 readFileState，允许 LLM 立即再次编辑 ─────────────────────
    recordWrite(absolutePath)

    // ── 格式化输出（标准 unified diff，含上下文 + 行号头）────────────────────
    const diff = formatDiff(fileContents, updatedFile)
    const suffix = replaceAll ? ' (all occurrences replaced)' : ''
    return {
      output: `The file ${filePath} has been updated successfully${suffix}.\n\`\`\`diff\n${diff}\n\`\`\``,
    }
  },

  renderResult(input, output, isError) {
    if (isError) return null
    const filePath = input['file_path'] as string
    const shownPath = displayPath(filePath)
    const diffMatch = output.match(/```diff\n([\s\S]*?)\n```/)
    if (!diffMatch) return [`Updated → ${shownPath}`]
    const diffLines = diffMatch[1]!.split('\n')
    const added = diffLines.filter(l => l.startsWith('+')).length
    const removed = diffLines.filter(l => l.startsWith('-')).length
    const header = `Updated → ${shownPath}  (+${added} / -${removed})`

    // @@ -oldStart,oldCount +newStart,newCount @@ → 推导每行的左侧行号沟。
    const hunk = diffLines[0]?.match(/^@@ -(\d+),\d+ \+(\d+),\d+ @@/)
    let oldNo = hunk ? Number(hunk[1]) : 1
    let newNo = hunk ? Number(hunk[2]) : 1
    const body = hunk ? diffLines.slice(1) : diffLines
    // 行号沟宽度：取本 hunk 出现的最大行号位数，右对齐。
    const maxNo = Math.max(oldNo + removed + added, newNo + removed + added)
    const gutterW = String(maxNo).length

    const banded = body.map(l => {
      const marker = l[0]
      const content = l.slice(1)
      if (marker === '+') {
        const g = String(newNo++).padStart(gutterW)
        return styleDiffLine(content, 'add', filePath, g)
      }
      if (marker === '-') {
        const g = String(oldNo++).padStart(gutterW)
        return styleDiffLine(content, 'remove', filePath, g)
      }
      // 上下文行：old/new 同步前进，沟里显示新文件行号。
      const g = String(newNo).padStart(gutterW)
      oldNo++; newNo++
      return styleDiffLine(content, 'context', filePath, g)
    })
    return [header, ...banded]
  },
})
