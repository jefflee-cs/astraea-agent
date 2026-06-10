// 记忆注入 —— 定稿 §3 决策 #10（三 payload 落点）。
//
//   ① 行为指令     → 系统 prompt 缓存段（loadMemoryInstructions）—— 稳定、进缓存前缀
//   ② MEMORY.md 索引 → reminder 块（loadMemoryIndex）—— 会内稳定
//   ③ relevant_memories → 当前用户消息尾部（buildRelevantMemoriesReminder）—— 逐消息变，远离前缀
//
// 决策 #11：年龄字符串在 build 时算一次固化（每 query 调用一次），同轮多次发送字节稳定。

import { memoryAge, memoryFreshnessText } from './age'
import { getEntrypointPath, getMemoryDir } from './paths'
import { buildMemoryLines } from './prompt'
import { truncateEntrypointContent } from './prompt'
import { findRelevantMemories } from './recall'

const AUTO_MEM_DISPLAY_NAME = 'auto memory'

/**
 * ① 行为指令段（注入系统 prompt 的 'memory' 缓存段）。
 * 替换旧 memory-injections.ts 的 dump-all：只放指令，不放任何记忆内容/索引。
 * 永远返回非空（指令是静态的）—— 记忆是否为空不影响是否教模型怎么用记忆。
 */
export function loadMemoryInstructions(cwd: string): string {
  return buildMemoryLines(AUTO_MEM_DISPLAY_NAME, getMemoryDir(cwd)).join('\n')
}

/**
 * ② MEMORY.md 索引内容（注入 reminder 块）。无索引/空 → null（调用方整段省略）。
 * 双上限截断（#22）。
 */
export async function loadMemoryIndex(cwd: string): Promise<string | null> {
  try {
    const raw = await Bun.file(getEntrypointPath(cwd)).text()
    if (!raw.trim()) return null
    const { content } = truncateEntrypointContent(raw)
    return `# Memory index (${getMemoryDir(cwd)}/MEMORY.md)\n${content}`
  } catch {
    return null // 文件不存在 —— 空起步的正常情况。
  }
}

/**
 * ③ relevant_memories reminder（拼到当前用户消息尾部）。
 * 跑召回选择 ≤5 条 → 读正文 → 加固化年龄头 + 陈旧 caveat → 包成 <system-reminder>。
 * 无相关记忆 → null。optional：召回失败返回空 → null，绝不阻塞。
 */
export async function buildRelevantMemoriesReminder(
  query: string,
  cwd: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<{ reminder: string; surfaced: string[] } | null> {
  if (!query.trim()) return null
  const selected = await findRelevantMemories(query, cwd, signal, recentTools, alreadySurfaced)
  if (selected.length === 0) return null

  const blocks: string[] = []
  const surfaced: string[] = []
  for (const m of selected) {
    let body: string
    try {
      body = (await Bun.file(m.path).text()).trim()
    } catch {
      continue // 文件刚被删 —— 跳过这条。
    }
    if (!body) continue
    surfaced.push(m.path)
    const filename = m.path.split('/').pop() ?? m.path
    const caveat = memoryFreshnessText(m.mtimeMs)
    blocks.push(
      `## ${filename} (saved ${memoryAge(m.mtimeMs)})\n${body}${caveat ? `\n\n> ${caveat}` : ''}`,
    )
  }
  if (blocks.length === 0) return null

  const reminder =
    `<system-reminder>\n` +
    `The following memories may be relevant to the current request. ` +
    `They are point-in-time notes, not live state — verify against the current code/files before relying on them.\n\n` +
    blocks.join('\n\n') +
    `\n</system-reminder>`
  return { reminder, surfaced }
}
