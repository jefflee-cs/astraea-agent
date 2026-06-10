// 记忆行为指令组装 + MEMORY.md 截断 —— 定稿 §2/§5。
//
// buildMemoryLines 拼出注入系统 prompt 的「行为指令」（类型规范/怎么存/防漂移/边界）。
// 决策 #22：MEMORY.md 双上限 + 换行边界截断（按真实字节量，切在换行处不裂字符）。
// 决策 #27：Memory vs Plan vs Task 边界本地化映射到 Orbit/Task/Vigil/goal。

import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from './types'

export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
// ~125 chars/行 × 200 行。字节上限抓「长行异常」（行数上限漏掉的 197KB/200 行）。
export const MAX_ENTRYPOINT_BYTES = 25_000

// harness 经 ensureMemoryDirExists 保证目录存在；告诉模型别 ls/mkdir，直接 Write。
export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'

export type EntrypointTruncation = {
  content: string
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

function byteLen(s: string): string {
  const n = Buffer.byteLength(s, 'utf8')
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`
}

/** 按真实字节裁到 ≤maxBytes，并回退到最后一个换行处（不裂多字节字符、不切半行）。 */
function cutBytesAtNewline(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let cut = Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8')
  const nl = cut.lastIndexOf('\n')
  // 回退到换行：既去掉可能的半个 CJK 字符（U+FFFD），又不切半行。
  if (nl > 0) cut = cut.slice(0, nl)
  return cut
}

/**
 * 把 MEMORY.md 内容裁到行 AND 字节双上限，追加点名哪个上限触发的警告。
 * 先按行裁（自然边界），再按字节在换行处裁。
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const lines = trimmed.split('\n')
  const lineCount = lines.length
  const byteCount = Buffer.byteLength(trimmed, 'utf8')

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, wasLineTruncated, wasByteTruncated }
  }

  let truncated = wasLineTruncated ? lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n') : trimmed
  truncated = cutBytesAtNewline(truncated, MAX_ENTRYPOINT_BYTES)

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${byteLen(trimmed)} (limit: ${byteLen('x'.repeat(MAX_ENTRYPOINT_BYTES))}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${byteLen(trimmed)}`

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. ` +
      `Keep index entries to one line under ~150 chars; move detail into topic files.`,
    wasLineTruncated,
    wasByteTruncated,
  }
}

/**
 * Memory vs Plan vs Task 边界（本地化映射 Orbit/Task/Vigil/goal，决策 #27）。
 * 防止模型把当前对话的临时状态/计划/调度误存进记忆。
 */
const PERSISTENCE_BOUNDARY: readonly string[] = [
  '## Memory and other forms of persistence',
  'Memory is one of several persistence mechanisms available to you. Memory is for information useful in FUTURE conversations — never for state that only matters within the current conversation. Use the right mechanism:',
  '- Plan alignment → Orbit mode. If you are about to start a non-trivial task and want to align on the approach, enter Orbit (plan) mode rather than saving the plan to memory. If your approach changes, update the plan, not a memory.',
  '- Step breakdown / progress → Task tools (TaskCreate/Update). Track the discrete steps of the current conversation as tasks, not memories.',
  '- Scheduled or deferred work → Vigil. One-off or recurring future runs go through Vigil scheduling, not memory.',
  '- Self-driving completion conditions → /goal. A goal you want to keep working toward this session is a goal directive, not a memory.',
  'Only what will still be useful in a *future* conversation belongs in memory.',
]

/**
 * 拼出完整的记忆行为指令（注入系统 prompt 的缓存段）。
 * 不含 MEMORY.md 索引内容本身 —— 索引走 reminder 块（#10），易变字节远离缓存前缀。
 */
export function buildMemoryLines(displayName: string, memoryDir: string): string[] {
  const howToSave = [
    '## How to save memories',
    '',
    'Saving a memory is a two-step process:',
    '',
    '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    `**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
    '',
    `- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
    '- Keep the name, description, and type fields in memory files up-to-date with the content',
    '- Organize memory semantically by topic, not chronologically',
    '- Update or remove memories that turn out to be wrong or outdated',
    '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
    '- In a memory body, link related memories with `[[name]]` (the other memory\'s name slug). Link liberally — a `[[name]]` that does not match an existing memory yet is fine; it marks something worth writing later, not an error. Do not create placeholder files just to resolve a link.',
  ]

  return [
    `# ${displayName}`,
    '',
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    '',
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...howToSave,
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    ...PERSISTENCE_BOUNDARY,
    '',
  ]
}
