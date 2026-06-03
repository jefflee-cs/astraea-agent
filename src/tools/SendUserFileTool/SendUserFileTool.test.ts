import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SendUserFileTool } from './index.js'

let tmpDir: string
let existingFile: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'astraea-sendfile-test-'))
  existingFile = join(tmpDir, 'report.md')
  writeFileSync(existingFile, '# Report\nContent here.')
})

afterEach(() => rmSync(tmpDir, { recursive: true }))

describe('SendUserFileTool — 校验', () => {
  test('文件不存在时返回错误', async () => {
    const r = await SendUserFileTool.call({ file_path: join(tmpDir, 'missing.md') }, { mode: 'default' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('missing.md')
  })

  test('相对路径被拒绝', async () => {
    const r = await SendUserFileTool.call({ file_path: 'relative/path.md' }, { mode: 'default' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('绝对路径')
  })

  test('缺少 file_path 参数', async () => {
    const r = await SendUserFileTool.call({}, { mode: 'default' })
    expect(r.isError).toBe(true)
  })
})

describe('SendUserFileTool — 正常交付', () => {
  test('存在的文件返回路径和文件名', async () => {
    const r = await SendUserFileTool.call({ file_path: existingFile }, { mode: 'default' })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('report.md')
    expect(r.output).toContain(existingFile)
  })

  test('带 description 时输出中包含说明', async () => {
    const r = await SendUserFileTool.call(
      { file_path: existingFile, description: '今日微信摘要' },
      { mode: 'default' }
    )
    expect(r.output).toContain('今日微信摘要')
  })

  test('输出包含文件大小信息', async () => {
    const r = await SendUserFileTool.call({ file_path: existingFile }, { mode: 'default' })
    expect(r.output).toMatch(/\d+\s*(B|KB|字节|bytes)/i)
  })
})

describe('SendUserFileTool — 元数据', () => {
  test('工具名称正确', () => { expect(SendUserFileTool.name).toBe('SendUserFile') })
  test('isReadOnly 为 true（无写副作用）', () => { expect(SendUserFileTool.isReadOnly({})).toBe(true) })
})
