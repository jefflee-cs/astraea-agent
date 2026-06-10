import { test, expect } from 'bun:test'
import { parseFrontmatter } from './frontmatter'
import { parseMemoryType } from './types'
import {
  truncateEntrypointContent,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
} from './prompt'
import { parseSelectedMemories } from './recall'
import { formatMemoryManifest, type MemoryHeader } from './scan'
import { memoryAge } from './age'
import { isMemoryPath, getMemoryDir, resetMemoryDirCache, getMemoryBaseDir } from './paths'

// ─── frontmatter（扁平 type:）───────────────────────────────────────────────
test('parseFrontmatter: 扁平 key:value，去引号', () => {
  const fm = parseFrontmatter(
    ['---', 'name: feedback_testing', 'description: "用真库不 mock"', 'type: feedback', '---', '', '正文'].join('\n'),
  )
  expect(fm.name).toBe('feedback_testing')
  expect(fm.description).toBe('用真库不 mock')
  expect(fm.type).toBe('feedback')
})

test('parseFrontmatter: 无 frontmatter → 空对象（优雅降级）', () => {
  expect(parseFrontmatter('just body, no fm')).toEqual({})
})

test('parseFrontmatter: 只读到结束 --- 为止', () => {
  const fm = parseFrontmatter(['---', 'type: user', '---', 'type: NOT_THIS'].join('\n'))
  expect(fm.type).toBe('user')
})

// ─── 类型解析 ────────────────────────────────────────────────────────────────
test('parseMemoryType: 合法/非法/缺失', () => {
  expect(parseMemoryType('feedback')).toBe('feedback')
  expect(parseMemoryType('bogus')).toBeUndefined()
  expect(parseMemoryType(undefined)).toBeUndefined()
  expect(parseMemoryType(123)).toBeUndefined()
})

// ─── MEMORY.md 截断（双上限 + 换行边界 + CJK 不裂）──────────────────────────
test('truncate: 短内容不动', () => {
  const r = truncateEntrypointContent('- [a](a.md) — x\n- [b](b.md) — y')
  expect(r.wasLineTruncated).toBe(false)
  expect(r.wasByteTruncated).toBe(false)
})

test('truncate: 超行数 → 截断 + 警告', () => {
  const raw = Array.from({ length: MAX_ENTRYPOINT_LINES + 50 }, (_, i) => `- line ${i}`).join('\n')
  const r = truncateEntrypointContent(raw)
  expect(r.wasLineTruncated).toBe(true)
  expect(r.content).toContain('WARNING')
  expect(r.content.split('\n').length).toBeLessThanOrEqual(MAX_ENTRYPOINT_LINES + 5)
})

test('truncate: 超字节(CJK 长行) → 不裂半个字符', () => {
  // 一行超 25K 字节的中文（每个中文 3 字节）
  const longLine = '记'.repeat(MAX_ENTRYPOINT_BYTES) // 3×25000 字节
  const r = truncateEntrypointContent('- 头部\n' + longLine)
  expect(r.wasByteTruncated).toBe(true)
  // 截断结果不含 U+FFFD（半个字符的替换符）
  expect(r.content).not.toContain('�')
})

// ─── 选择器输出解析（文本 → 文件名数组）──────────────────────────────────────
test('parseSelectedMemories: 纯 JSON 对象', () => {
  expect(parseSelectedMemories('{"selected_memories":["a.md","b.md"]}')).toEqual(['a.md', 'b.md'])
})

test('parseSelectedMemories: 裹 prose / 代码围栏', () => {
  expect(
    parseSelectedMemories('Here:\n```json\n{"selected_memories": ["x.md"]}\n```\nDone'),
  ).toEqual(['x.md'])
})

test('parseSelectedMemories: 裸数组兜底', () => {
  expect(parseSelectedMemories('["a.md", "b.md"]')).toEqual(['a.md', 'b.md'])
})

test('parseSelectedMemories: 垃圾输入 → 空', () => {
  expect(parseSelectedMemories('no json here')).toEqual([])
})

// ─── manifest 格式 ───────────────────────────────────────────────────────────
test('formatMemoryManifest: 每文件一行带 type/时间/描述', () => {
  const headers: MemoryHeader[] = [
    { filename: 'feedback_testing.md', filePath: '/m/feedback_testing.md', mtimeMs: Date.parse('2026-04-01T00:00:00Z'), description: '用真库', type: 'feedback' },
  ]
  const out = formatMemoryManifest(headers)
  expect(out).toContain('[feedback] feedback_testing.md')
  expect(out).toContain('用真库')
})

// ─── 年龄 ────────────────────────────────────────────────────────────────────
test('memoryAge: today/yesterday/N days', () => {
  const now = Date.now()
  expect(memoryAge(now)).toBe('today')
  expect(memoryAge(now - 86_400_000)).toBe('yesterday')
  expect(memoryAge(now - 47 * 86_400_000)).toBe('47 days ago')
})

// ─── 路径：身份 + 写豁免判定 ─────────────────────────────────────────────────
test('getMemoryDir: 落在 ~/.astraea/projects/<slug>/memory', () => {
  resetMemoryDirCache()
  const dir = getMemoryDir('/tmp/no-git-here-xyz')
  expect(dir.startsWith(getMemoryBaseDir())).toBe(true)
  expect(dir.endsWith('/memory')).toBe(true)
})

test('isMemoryPath: 只认 memoryDir 子树，防 .. 穿越', () => {
  resetMemoryDirCache()
  const cwd = '/tmp/no-git-here-xyz'
  const dir = getMemoryDir(cwd)
  expect(isMemoryPath(`${dir}/feedback.md`, cwd)).toBe(true)
  expect(isMemoryPath(dir, cwd)).toBe(true)
  expect(isMemoryPath(`${dir}/../../../etc/passwd`, cwd)).toBe(false)
  expect(isMemoryPath('/etc/passwd', cwd)).toBe(false)
})
