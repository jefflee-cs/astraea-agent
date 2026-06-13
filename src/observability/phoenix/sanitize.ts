// ─────────────────────────────────────────────────────────────────────────────
// 脱敏（打码机）—— 与监控平台无关，上传前对敏感数据打码。
// 对标 claude-code: src/services/langfuse/sanitize.ts
//
// 红线：astraea 的工具 I/O 天然包含文件内容、shell 输出、API 密钥，
// 原样上传 = 泄密。所有进 span 的 input/output 必须先过这里。
// ─────────────────────────────────────────────────────────────────────────────

import { homedir } from 'node:os'

const HOME = (() => {
  try {
    return homedir()
  } catch {
    return ''
  }
})()

// 命中即遮蔽的敏感字段名（大小写不敏感、含子串即可）
const SENSITIVE_KEY = /(api[_-]?key|secret|password|passwd|token|credential|auth[_-]?header|bearer|private[_-]?key)/i

const REDACTED = '[REDACTED]'

/** 把字符串里的 home 目录换成 ~（别暴露电脑用户名）。 */
export function redactHome(s: string): string {
  if (!HOME || !s) return s
  return s.split(HOME).join('~')
}

/**
 * 深度遍历任意值：命中敏感字段名 → 替换成 [REDACTED]；字符串里的 home 路径 → ~。
 * 返回脱敏后的克隆，不改原对象。带循环引用保护与深度上限。
 */
export function sanitizeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return '[truncated: too deep]'
  if (typeof value === 'string') return redactHome(value)
  if (value === null || typeof value !== 'object') return value

  if (seen.has(value as object)) return '[circular]'
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1, seen))
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : sanitizeValue(v, depth + 1, seen)
  }
  return out
}

/** 全局脱敏入口（home + 敏感字段）。 */
export function sanitizeGlobal(data: unknown): unknown {
  return sanitizeValue(data)
}

/** 工具入参脱敏：敏感字段遮蔽 + 路径 home 替换。 */
export function sanitizeToolInput(_toolName: string, input: unknown): unknown {
  return sanitizeValue(input)
}

const FILE_TOOLS = new Set(['FileReadTool', 'FileWriteTool', 'FileEditTool', 'NotebookEditTool'])
const SHELL_TOOLS = new Set(['BashTool', 'PowerShellTool'])
const FULLY_REDACT_TOOLS = new Set(['ConfigTool', 'ReadMcpResourceTool'])
const SHELL_MAX = 500

/**
 * 工具输出脱敏（按工具类型分策略，对标 claude-code）：
 *   文件类   → 整段抹掉，仅留字数
 *   shell 类 → 截断到 500 字
 *   配置/MCP → 完全遮蔽
 *   其它     → 仅做 home 路径替换
 */
export function sanitizeToolOutput(toolName: string, output: string): string {
  if (output == null) return ''
  if (FILE_TOOLS.has(toolName)) return `[file content redacted, ${output.length} chars]`
  if (SHELL_TOOLS.has(toolName)) {
    const clipped = output.length > SHELL_MAX ? `${output.slice(0, SHELL_MAX)}… [+${output.length - SHELL_MAX} chars]` : output
    return redactHome(clipped)
  }
  if (FULLY_REDACT_TOOLS.has(toolName)) return '[output redacted]'
  return redactHome(output)
}
