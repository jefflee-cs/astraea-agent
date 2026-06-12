import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillTool } from './index.js'
import { _setSkillDirsForTest } from '../../skills/loadSkillsDir'
import { resetCommandsCache } from '../../commands/registry'

let tmpDir: string

function writeSkill(name: string, content: string) {
  const dir = join(tmpDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content)
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'astraea-skill-test-'))
  _setSkillDirsForTest({ userDir: tmpDir })
  resetCommandsCache()
})

afterEach(() => {
  _setSkillDirsForTest({})
  resetCommandsCache()
  rmSync(tmpDir, { recursive: true })
})

describe('SkillTool — 执行技能', () => {
  test('找到技能并返回其内容', async () => {
    writeSkill('code-review', '---\ndescription: review\n---\n# Code Review\nReview the code carefully.')
    const r = await SkillTool.call({ skill: 'code-review' }, { mode: 'default' })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Review the code carefully')
  })

  test('技能不存在时返回可用技能列表', async () => {
    writeSkill('deploy', '---\ndescription: deploy\n---\n# Deploy')
    writeSkill('test', '---\ndescription: test\n---\n# Test')
    const r = await SkillTool.call({ skill: 'nonexistent' }, { mode: 'default' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('deploy')
    expect(r.output).toContain('test')
  })

  test('技能目录为空时返回友好提示', async () => {
    const r = await SkillTool.call({ skill: 'anything' }, { mode: 'default' })
    expect(r.isError).toBe(true)
    expect(r.output.toLowerCase()).toContain('no skills')
  })

  test('带 args 参数时内容追加 args 上下文', async () => {
    writeSkill('grill', '---\ndescription: grill\n---\n# Grill Me\nAsk questions.')
    const r = await SkillTool.call({ skill: 'grill', args: 'my API design' }, { mode: 'default' })
    expect(r.output).toContain('my API design')
  })

  test('disable-model-invocation 的技能模型调不到', async () => {
    writeSkill('secret', '---\ndescription: secret\ndisable-model-invocation: true\n---\n# Secret')
    const r = await SkillTool.call({ skill: 'secret' }, { mode: 'default' })
    expect(r.isError).toBe(true)
  })
})

describe('SkillTool — 元数据', () => {
  test('工具名称正确', () => { expect(SkillTool.name).toBe('Skill') })
  test('isReadOnly 为 true', () => { expect(SkillTool.isReadOnly({})).toBe(true) })
})
