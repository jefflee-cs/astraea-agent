import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'

type Severity = 'error' | 'warning' | 'info'

interface Annotation {
  line: number
  message: string
  severity: Severity
}
const SEVERITY_PREFIX: Record<Severity, string> = {
  error:   '🔴 error',
  warning: '🟡 warning',
  info:    '🔵 info',
}
export const ReviewArtifactTool = buildTool({
  name: 'ReviewArtifact',
  description: `Output a structured code review with per-line annotations and a summary.

This tool does NOT perform any analysis — it is a display container.
The LLM generates the review content and passes it here for structured rendering.

severity levels: "error" (must fix) | "warning" (recommend fix) | "info" (suggestion)`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      artifact:    { type: 'string', description: 'The code or content being reviewed' },
      title:       { type: 'string', description: 'Optional review title (e.g. "PR #42 审查")' },
      annotations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line:     { type: 'number' },
            message:  { type: 'string' },
            severity: { type: 'string', enum: ['error', 'warning', 'info'] },
          },
          required: ['line', 'message', 'severity'],
        },
        description: 'Per-line review comments',
      },
      summary: { type: 'string', description: 'Overall review conclusion' },
    },
    required: ['artifact'],
  },

  async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolCallResult> {
    const title       = input['title']   ? String(input['title'])   : undefined
    const summary     = input['summary'] ? String(input['summary']) : undefined
    const annotations = (input['annotations'] as Annotation[] | undefined) ?? []

    const lines: string[] = []

    if (title) lines.push(`# ${title}`, '')

    const sorted = [...annotations].sort((a, b) => a.line - b.line)
    if (sorted.length > 0) {
      lines.push('## 注释', '')
      for (const ann of sorted) {
        lines.push(`L${ann.line}  [${SEVERITY_PREFIX[ann.severity] ?? ann.severity}]  ${ann.message}`)
      }
      lines.push('')
    }

    if (summary) {
      lines.push('## 总结', '', summary)
    }

    return { output: lines.join('\n') }
  },
})
