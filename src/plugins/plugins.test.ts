import { test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setPluginsRootForTest } from './directories'
import { addMarketplace, resolvePluginEntry, listMarketplaces } from './marketplaceManager'
import { materialize } from './materialize'
import { addInstallRecord, listInstalled, setEnabled, removeInstallRecord, listEnabledInstalled } from './installedManager'
import { parsePluginManifest, parseMarketplace } from './schemas'
import { initPlugins, getPluginStatus } from './init'
import { getCommands, findCommand, resetCommandsCache, _setPluginSkillSource } from '../commands/registry'
import { _setSkillDirsForTest } from '../skills/loadSkillsDir'
import { _setPluginMcpSource } from '../mcp/config'

const tmps: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmps.push(d)
  return d
}

// 造一个货架：含 marketplace.json + 一个带 plugin.json + skills 的插件目录
function buildShelf(): { shelf: string; pluginName: string } {
  const shelf = tmp('astraea-shelf-')
  const pluginDir = join(shelf, 'my-plugin')
  mkdirSync(join(pluginDir, '.astraea-plugin'), { recursive: true })
  writeFileSync(join(pluginDir, '.astraea-plugin', 'plugin.json'), JSON.stringify({
    name: 'my-plugin', version: '1.2.0', description: 'test plugin',
    mcpServers: { db: { type: 'http', url: 'https://db.example/mcp' } },
  }))
  // 约定 skills/ 自动探测
  mkdirSync(join(pluginDir, 'skills', 'plugin-skill'), { recursive: true })
  writeFileSync(join(pluginDir, 'skills', 'plugin-skill', 'SKILL.md'),
    '---\ndescription: a skill from a plugin\n---\n# Plugin Skill\nbody')

  mkdirSync(join(shelf, '.astraea-plugin'), { recursive: true })
  writeFileSync(join(shelf, '.astraea-plugin', 'marketplace.json'), JSON.stringify({
    name: 'test-shelf',
    plugins: [{ name: 'my-plugin', source: './my-plugin', description: 'test plugin' }],
  }))
  return { shelf, pluginName: 'my-plugin' }
}

beforeEach(() => {
  _setPluginsRootForTest(tmp('astraea-proot-'))
  _setSkillDirsForTest({ userDir: tmp('astraea-emptyskills-') }) // 空，避免读真实 ~/.astraea
  resetCommandsCache()
})

afterEach(() => {
  _setPluginsRootForTest(undefined)
  _setSkillDirsForTest({})
  _setPluginSkillSource(() => [])
  _setPluginMcpSource(() => [])  // 清除 initPlugins 注入的全局 MCP 源，防污染其它测试
  resetCommandsCache()
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true })
})

test('parsePluginManifest: name required, skills归一, parse-but-ignore保留', () => {
  expect('error' in parsePluginManifest({})).toBe(true)
  const r = parsePluginManifest({ name: 'p', skills: './s', hooks: { x: 1 } })
  expect('manifest' in r && r.manifest.skills).toEqual(['./s'])
  expect('manifest' in r && (r.manifest as unknown as Record<string, unknown>).hooks).toEqual({ x: 1 })
})

test('parseMarketplace: only directory source kept', () => {
  const r = parseMarketplace({ name: 'm', plugins: [
    { name: 'a', source: './a' },
    { name: 'b', source: { source: 'git', url: 'x' } }, // 非 directory → 跳过
  ] })
  expect('marketplace' in r && r.marketplace.plugins.map(p => p.name)).toEqual(['a'])
})

test('addMarketplace + resolvePluginEntry', () => {
  const { shelf } = buildShelf()
  const add = addMarketplace(shelf)
  expect('name' in add && add.name).toBe('test-shelf')
  expect(listMarketplaces()[0]!.pluginCount).toBe(1)
  const resolved = resolvePluginEntry('my-plugin')
  expect('pluginDir' in resolved).toBe(true)
})

test('materialize: atomic copy to versioned cache + manifest read', () => {
  const { shelf } = buildShelf()
  const mat = materialize(join(shelf, 'my-plugin'), 'test-shelf')
  expect(mat.version).toBe('1.2.0')
  expect(mat.manifest.name).toBe('my-plugin')
  expect(existsSync(join(mat.installPath, '.astraea-plugin', 'plugin.json'))).toBe(true)
  expect(existsSync(join(mat.installPath, 'skills', 'plugin-skill', 'SKILL.md'))).toBe(true)
  expect(mat.installPath).toContain(join('cache', 'test-shelf', 'my-plugin', '1.2.0'))
})

test('end-to-end: marketplace add → install → initPlugins → skill in command table', () => {
  const { shelf } = buildShelf()
  addMarketplace(shelf)
  const resolved = resolvePluginEntry('my-plugin')
  if ('error' in resolved) throw new Error(resolved.error)
  const mat = materialize(resolved.pluginDir, resolved.marketplaceName)
  addInstallRecord({
    pluginId: 'my-plugin', marketplace: 'test-shelf', version: mat.version,
    installPath: mat.installPath, scope: 'user', enabled: true, installedAt: new Date().toISOString(),
  })

  initPlugins()
  resetCommandsCache()
  expect(getPluginStatus()[0]!.state).toBe('loaded')

  const skill = findCommand('plugin-skill')
  expect(skill?.type).toBe('prompt')
  expect(skill && (skill as { source: string }).source).toBe('plugin')
})

test('disable → skill drops out; uninstall → record + cache gone', () => {
  const { shelf } = buildShelf()
  addMarketplace(shelf)
  const r = resolvePluginEntry('my-plugin')
  if ('error' in r) throw new Error(r.error)
  const mat = materialize(r.pluginDir, r.marketplaceName)
  addInstallRecord({
    pluginId: 'my-plugin', marketplace: 'test-shelf', version: mat.version,
    installPath: mat.installPath, scope: 'user', enabled: true, installedAt: new Date().toISOString(),
  })

  setEnabled('my-plugin', false)
  expect(listEnabledInstalled().length).toBe(0)
  initPlugins(); resetCommandsCache()
  expect(findCommand('plugin-skill')).toBeUndefined()

  const removed = removeInstallRecord('my-plugin')
  expect(removed.length).toBe(1)
  expect(listInstalled().length).toBe(0)
})

test('install plugin contributes MCP server (plugin scope)', () => {
  const { shelf } = buildShelf()
  addMarketplace(shelf)
  const r = resolvePluginEntry('my-plugin')
  if ('error' in r) throw new Error(r.error)
  const mat = materialize(r.pluginDir, r.marketplaceName)
  addInstallRecord({
    pluginId: 'my-plugin', marketplace: 'test-shelf', version: mat.version,
    installPath: mat.installPath, scope: 'user', enabled: true, installedAt: new Date().toISOString(),
  })
  initPlugins()
  // 经 _setPluginMcpSource 注入；loadMcpServers 在空 cwd 下应含 plugin server
  const { loadMcpServers } = require('../mcp/config')
  const servers = loadMcpServers(tmp('astraea-nocwd-'))
  const pluginServer = servers.find((s: { name: string }) => s.name === 'my-plugin:db')
  expect(pluginServer?.scope).toBe('plugin')
})
