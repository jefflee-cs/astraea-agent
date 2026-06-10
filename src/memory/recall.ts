// 按需召回 —— 定稿 §3 通道②。
//
// 每条用户消息跑一次：扫 frontmatter → manifest → querySmallModel 选 ≤5 条 → 返回路径+mtime。
// 决策 #8 复用 querySmallModel（Haiku/各 provider 小模型）；#9 文本解析 + 白名单过滤；
// #12 零记忆提前返回、optional 失败不阻塞；#13 recentTools 去噪 + alreadySurfaced 去重。

import { querySmallModel } from '../api/query-model'
import { getMemoryDir } from './paths'
import { formatMemoryManifest, type MemoryHeader, scanMemoryFiles } from './scan'

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to an AI coding assistant (Astraea) as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object of the form {"selected_memories": ["file_a.md", "file_b.md"]} listing the filenames (up to 5) of the memories that will clearly be useful for this query. Only include memories you are CERTAIN will help based on their name and description.
- If you are unsure whether a memory will be useful, do NOT include it. Be selective and discerning.
- If none would clearly be useful, return {"selected_memories": []}.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (the assistant is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
Respond with ONLY the JSON object, no prose.`

/**
 * 找与 query 相关的记忆文件（≤5）。返回绝对路径 + mtime（mtime 透传，调用方
 * 不用二次 stat 即可算年龄）。排除 MEMORY.md（已全量注入）。
 * alreadySurfaced 在送进选择器之前过滤，让 5 槽预算只花在新候选上。
 */
export async function findRelevantMemories(
  query: string,
  cwd: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  if (signal.aborted) return []
  const memoryDir = getMemoryDir(cwd)
  const memories = (await scanMemoryFiles(memoryDir)).filter(m => !alreadySurfaced.has(m.filePath))
  if (memories.length === 0) return []

  const selectedFilenames = await selectRelevantMemories(query, memories, signal, recentTools)
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  return selectedFilenames
    .map(f => byFilename.get(f))
    .filter((m): m is MemoryHeader => m !== undefined)
    .map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
  signal: AbortSignal,
  recentTools: readonly string[],
): Promise<string[]> {
  const validFilenames = new Set(memories.map(m => m.filename))
  const manifest = formatMemoryManifest(memories)
  const toolsSection = recentTools.length > 0 ? `\n\nRecently used tools: ${recentTools.join(', ')}` : ''
  const userPrompt = `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`

  try {
    const raw = await querySmallModel(userPrompt, signal, SELECT_MEMORIES_SYSTEM_PROMPT)
    const filenames = parseSelectedMemories(raw)
    // 白名单过滤防幻觉文件名（同时兜解析鲁棒性）。
    return filenames.filter(f => validFilenames.has(f))
  } catch {
    // optional：失败/超时/abort 一律返回空，绝不阻塞主对话。
    return []
  }
}

/**
 * 从小模型文本里抽出 selected_memories 数组。容忍模型在 JSON 前后裹 prose 或
 * markdown 代码围栏：定位第一个 {...} 块解析；失败再兜底找裸数组。
 */
export function parseSelectedMemories(raw: string): string[] {
  const tryParse = (s: string): string[] | null => {
    try {
      const obj = JSON.parse(s)
      if (Array.isArray(obj?.selected_memories)) {
        return obj.selected_memories.filter((x: unknown): x is string => typeof x === 'string')
      }
      if (Array.isArray(obj)) {
        return obj.filter((x: unknown): x is string => typeof x === 'string')
      }
    } catch {
      // 继续兜底
    }
    return null
  }

  // 1) 整段就是 JSON
  const whole = tryParse(raw.trim())
  if (whole) return whole

  // 2) 抽第一个 { ... } 对象块
  const objStart = raw.indexOf('{')
  const objEnd = raw.lastIndexOf('}')
  if (objStart !== -1 && objEnd > objStart) {
    const obj = tryParse(raw.slice(objStart, objEnd + 1))
    if (obj) return obj
  }

  // 3) 抽第一个 [ ... ] 数组块
  const arrStart = raw.indexOf('[')
  const arrEnd = raw.lastIndexOf(']')
  if (arrStart !== -1 && arrEnd > arrStart) {
    const arr = tryParse(raw.slice(arrStart, arrEnd + 1))
    if (arr) return arr
  }

  return []
}
