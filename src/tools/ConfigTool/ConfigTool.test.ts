import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigTool, _setSettingsPathForTest } from './index.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'astraea-config-test-'))
  _setSettingsPathForTest(join(tmpDir, 'settings.json'))
})

afterEach(() => {
  _setSettingsPathForTest(undefined)
  rmSync(tmpDir, { recursive: true })
})

describe('ConfigTool — 读取', () => {
  test('读取存在的顶层 key', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), JSON.stringify({ model: 'claude-opus' }))
    const r = await ConfigTool.call({ key: 'model' }, { mode: 'default' })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('claude-opus')
  })

  test('读取嵌套 key（点分路径）', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), JSON.stringify({ wechat: { days: 7 } }))
    const r = await ConfigTool.call({ key: 'wechat.days' }, { mode: 'default' })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('7')
  })

  test('读取不存在的 key 返回提示而非报错', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), JSON.stringify({}))
    const r = await ConfigTool.call({ key: 'nonexistent' }, { mode: 'default' })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('nonexistent')
  })

  test('settings.json 不存在时读取视为空对象', async () => {
    const r = await ConfigTool.call({ key: 'model' }, { mode: 'default' })
    expect(r.isError).toBeFalsy()
  })
})

describe('ConfigTool — 写入', () => {
  test('写入顶层 key 后可读回', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), JSON.stringify({}))
    await ConfigTool.call({ key: 'model', value: 'claude-sonnet' }, { mode: 'default' })
    const r = await ConfigTool.call({ key: 'model' }, { mode: 'default' })
    expect(r.output).toContain('claude-sonnet')
  })

  test('写入嵌套 key 保留已有同级字段', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), JSON.stringify({ wechat: { days: 7, outputDir: '~/docs' } }))
    await ConfigTool.call({ key: 'wechat.days', value: 14 }, { mode: 'default' })
    const r = await ConfigTool.call({ key: 'wechat.outputDir' }, { mode: 'default' })
    expect(r.output).toContain('~/docs')
  })

  test('写入返回 before / after', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), JSON.stringify({ model: 'old' }))
    const r = await ConfigTool.call({ key: 'model', value: 'new' }, { mode: 'default' })
    expect(r.output).toContain('old')
    expect(r.output).toContain('new')
  })

})

describe('ConfigTool — 元数据', () => {
  test('工具名称正确', () => { expect(ConfigTool.name).toBe('Config') })
  test('无 value 时 isReadOnly 为 true（读操作）', () => { expect(ConfigTool.isReadOnly({})).toBe(true) })
  test('有 value 时 isReadOnly 为 false（写操作）', () => { expect(ConfigTool.isReadOnly({ key: 'model', value: 'x' })).toBe(false) })
})
