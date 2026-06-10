// 记忆目录扫描 —— 定稿 §3。读 frontmatter → manifest，喂给召回选择器和提取 agent。
//
// 四件套（对齐 claude-code memoryScan.ts）：
//   1. 只读头部（前 30 行足够拿 description+type，省 IO）
//   2. 单遍 read + stat（Bun.file 拿 mtime + 内容一次完成）
//   3. Promise.allSettled 容错（单文件损坏不拖垮整扫描）
//   4. newest-first 截断 200（召回成本有上限）

import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseFrontmatter } from './frontmatter'
import { type MemoryType, parseMemoryType } from './types'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30

/** 读文件前 N 行 + mtime（Bun.file：text 读内容，lastModified 拿 mtime）。 */
async function readHead(filePath: string, maxLines: number): Promise<{ content: string; mtimeMs: number }> {
  const file = Bun.file(filePath)
  const raw = await file.text()
  const content = raw.split('\n', maxLines).join('\n')
  return { content, mtimeMs: file.lastModified }
}

/**
 * 扫描记忆目录所有 .md（排除 MEMORY.md，索引已全量注入），读 frontmatter，
 * 返回 newest-first（按 mtime 降序）截断 200 的 header 列表。
 */
export async function scanMemoryFiles(memoryDir: string): Promise<MemoryHeader[]> {
  let entries: string[]
  try {
    entries = await readdir(memoryDir, { recursive: true })
  } catch {
    return [] // 目录不存在/不可读 —— 空起步的正常情况。
  }

  const mdFiles = entries.filter(f => f.endsWith('.md') && basename(f) !== 'MEMORY.md')

  const results = await Promise.allSettled(
    mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
      const filePath = join(memoryDir, relativePath)
      const { content, mtimeMs } = await readHead(filePath, FRONTMATTER_MAX_LINES)
      const fm = parseFrontmatter(content)
      return {
        filename: relativePath,
        filePath,
        mtimeMs,
        description: fm.description || null,
        type: parseMemoryType(fm.type),
      }
    }),
  )

  return results
    .filter((r): r is PromiseFulfilledResult<MemoryHeader> => r.status === 'fulfilled')
    .map(r => r.value)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES)
}

/**
 * Header 列表 → 文本 manifest：每文件一行 `- [type] filename (ISO): description`。
 * 召回选择器和提取 agent 共用。
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
