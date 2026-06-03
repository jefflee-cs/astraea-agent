import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillTool, _setSkillsDirForTest } from './index.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'astraea-skill-test-'))
  _setSkillsDirForTest(tmpDir)
})

afterEach(() => {
  _setSkillsDirForTest(undefined)
  rmSync(tmpDir, { recursive: true })
})

describe('SkillTool — 执行技能', () => {
  test('找到技能文件并返回其内容', async () => {
    writeFileSync(join(tmpDir, 'code-review.md'), '# Code Review\nReview the code carefully.')
    const r = await SkillTool.call({ skill: 'code-review' }, { mode: 'default' })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Review the code carefully')
  })

  test('技能不存在时返回可用技能列表', async () => {
    writeFileSync(join(tmpDir, 'deploy.md'), '# Deploy')
    writeFileSync(join(tmpDir, 'test.md'), '# Test')
    const r = await SkillTool.call({ skill: 'nonexistent' }, { mode: 'default' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('deploy')
    expect(r.output).toContain('test')
  })

  test('技能目录为空时返回友好提示', async () => {
    const r = await SkillTool.call({ skill: 'anything' }, { mode: 'default' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('没有')
  })

  test('带 args 参数时内容追加 args 上下文', async () => {
    writeFileSync(join(tmpDir, 'grill.md'), '# Grill Me\nAsk questions.')
    const r = await SkillTool.call({ skill: 'grill', args: 'my API design' }, { mode: 'default' })
    expect(r.output).toContain('my API design')
  })

  test('技能名允许带或不带 .md 后缀', async () => {
    writeFileSync(join(tmpDir, 'simplify.md'), '# Simplify')
    const withExt = await SkillTool.call({ skill: 'simplify.md' }, { mode: 'default' })
    const withoutExt = await SkillTool.call({ skill: 'simplify' }, { mode: 'default' })
    expect(withExt.isError).toBeFalsy()
    expect(withoutExt.isError).toBeFalsy()
  })
})

describe('SkillTool — 元数据', () => {
  test('工具名称正确', () => { expect(SkillTool.name).toBe('Skill') })
  test('isReadOnly 为 true', () => { expect(SkillTool.isReadOnly({})).toBe(true) })
})
