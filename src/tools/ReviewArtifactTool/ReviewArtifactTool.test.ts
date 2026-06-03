import { describe, test, expect } from 'bun:test'
import { ReviewArtifactTool } from './index.js'

describe('ReviewArtifactTool — 输出格式', () => {
  test('无注释时仅输出摘要', async () => {
    const r = await ReviewArtifactTool.call(
      { artifact: 'const x = 1', summary: 'LGTM' },
      { mode: 'default' }
    )
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('LGTM')
  })

  test('注释按行号排序输出', async () => {
    const r = await ReviewArtifactTool.call({
      artifact: 'code',
      annotations: [
        { line: 10, message: 'later issue',  severity: 'warning' },
        { line: 2,  message: 'early issue',  severity: 'error'   },
      ],
    }, { mode: 'default' })
    const out = r.output
    expect(out.indexOf('L2')).toBeLessThan(out.indexOf('L10'))
  })

  test('error 级别注释在输出中可识别', async () => {
    const r = await ReviewArtifactTool.call({
      artifact: 'code',
      annotations: [{ line: 5, message: 'null pointer risk', severity: 'error' }],
    }, { mode: 'default' })
    expect(r.output).toContain('error')
    expect(r.output).toContain('null pointer risk')
  })

  test('带 title 时标题出现在输出中', async () => {
    const r = await ReviewArtifactTool.call({
      artifact: 'code',
      title: 'PR #42 审查',
      summary: 'Good',
    }, { mode: 'default' })
    expect(r.output).toContain('PR #42')
  })

  test('空 annotations 数组不报错', async () => {
    const r = await ReviewArtifactTool.call({
      artifact: 'const x = 1',
      annotations: [],
      summary: 'Clean code',
    }, { mode: 'default' })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Clean code')
  })
})

describe('ReviewArtifactTool — 元数据', () => {
  test('工具名称正确', () => { expect(ReviewArtifactTool.name).toBe('ReviewArtifact') })
  test('isReadOnly 为 true', () => { expect(ReviewArtifactTool.isReadOnly({})).toBe(true) })
})
