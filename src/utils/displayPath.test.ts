import { test, expect } from 'bun:test'
import { join } from 'node:path'
import { displayPath } from './displayPath'

test('paths inside cwd become relative', () => {
  const abs = join(process.cwd(), 'src/ui/App.tsx')
  expect(displayPath(abs)).toBe('src/ui/App.tsx')
})

test('a file directly in cwd shows just its name', () => {
  expect(displayPath(join(process.cwd(), 'README.md'))).toBe('README.md')
})

test('paths outside cwd stay absolute (no ../../.. churn)', () => {
  // 取一个一定在 cwd 之外的绝对路径。
  const out = displayPath('/etc/hosts')
  expect(out).toBe('/etc/hosts')
})

test('over-long paths are middle-ellipsized, never split arbitrarily', () => {
  const longRel = 'a/'.repeat(60) + 'file.ts'
  const abs = join(process.cwd(), longRel)
  const shown = displayPath(abs, 40)
  expect(shown.length).toBeLessThanOrEqual(40)
  expect(shown).toContain('…')
  expect(shown.endsWith('file.ts')).toBe(true) // 文件名尾部保留
})
