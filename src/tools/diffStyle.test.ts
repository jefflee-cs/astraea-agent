import { test, expect } from 'bun:test'
import { commentSyntaxFor, splitCodeComment, styleDiffLine } from './diffStyle'

// ANSI 片段（chalk truecolor）：
const ADD_BG = '48;2;20;51;33'      // 深森绿背景
const DEL_BG = '48;2;58;26;30'      // 深褐红背景
const COMMENT = '38;2;122;138;170'  // 灰注释
const TEXT = '38;2;232;232;232'     // 白正文

test('commentSyntaxFor: 按扩展名映射', () => {
  expect(commentSyntaxFor('/a/b.ts')).toEqual({ line: ['//'], block: [['/*', '*/']] })
  expect(commentSyntaxFor('/a/b.py')?.line).toEqual(['#'])
  expect(commentSyntaxFor('/a/b.md')).toEqual({ line: [], block: [['<!--', '-->']] })
  expect(commentSyntaxFor('/a/Makefile')?.line).toEqual(['#'])
  expect(commentSyntaxFor('/a/unknown.xyz')).toBeNull()
})

test('splitCodeComment: 跳过字符串内的 //（无 http:// 误伤）', () => {
  const segs = splitCodeComment('a = "http://x.com" // real', commentSyntaxFor('/x.ts')!)
  expect(segs).toEqual([
    { text: 'a = "http://x.com" ', kind: 'code' },
    { text: '// real', kind: 'comment' },
  ])
})

test('splitCodeComment: 单行块注释，注释后仍有代码', () => {
  const segs = splitCodeComment('x /* mid */ y', commentSyntaxFor('/x.ts')!)
  expect(segs).toEqual([
    { text: 'x ', kind: 'code' },
    { text: '/* mid */', kind: 'comment' },
    { text: ' y', kind: 'code' },
  ])
})

test('splitCodeComment: 无注释 → 全 code', () => {
  const segs = splitCodeComment('const x = 1', commentSyntaxFor('/x.ts')!)
  expect(segs).toEqual([{ text: 'const x = 1', kind: 'code' }])
})

test('styleDiffLine: 添加行走绿带、注释灰、正文白', () => {
  const out = styleDiffLine('x = 1 // c', 'add', '/a/b.ts')
  expect(out).toContain(ADD_BG)     // 绿背景
  expect(out).toContain(TEXT)       // 白正文
  expect(out).toContain(COMMENT)    // 灰注释
  expect(out).not.toContain(DEL_BG)
})

test('styleDiffLine: 删除行走红带', () => {
  const out = styleDiffLine('gone()', 'remove', '/a/b.ts')
  expect(out).toContain(DEL_BG)
  expect(out).not.toContain(ADD_BG)
})

test('styleDiffLine: 未知语法 → 无灰注释（整行白）', () => {
  const out = styleDiffLine('# not a comment in md', 'add', '/a/doc.md')
  expect(out).toContain(ADD_BG)
  expect(out).not.toContain(COMMENT)  // md 无行注释，# 不灰化
})

test('styleDiffLine: 满宽带 —— 去 ANSI 后可见宽度达目标', () => {
  ;(process.stdout as { columns?: number }).columns = 60
  const out = styleDiffLine('ab', 'add', '/a/b.ts')
  // 去 ANSI 后应被空格补齐到 60-8=52 宽
  // eslint-disable-next-line no-control-regex
  const visible = out.replace(/\x1b\[[0-9;]*m/g, '')
  expect(visible.length).toBe(52)
})
