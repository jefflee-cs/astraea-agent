// 安全红线 + 模式权限矩阵 单元测试（Permission & Safety Technical Spec §1.3 / §5）

import { test, expect, describe } from 'bun:test'
import { isSensitivePath, commandTouchesSensitivePath } from './redlines'
import {
  fileWriteBehavior,
  shellAskBehavior,
  isModelEnterable,
} from '../state/sessionMode'
import { appendPermissionRule } from './permissions'

describe('isSensitivePath', () => {
  test('flags .git / .astraea / .claude writes', () => {
    expect(isSensitivePath('/proj/.git/config')).toBe(true)
    expect(isSensitivePath('/proj/.astraea/settings.json')).toBe(true)
    expect(isSensitivePath('/proj/.claude/settings.json')).toBe(true)
  })
  test('flags shell startup files', () => {
    expect(isSensitivePath('/Users/me/.zshrc')).toBe(true)
    expect(isSensitivePath('/Users/me/.bashrc')).toBe(true)
    expect(isSensitivePath('/Users/me/.profile')).toBe(true)
  })
  test('allows ordinary project files', () => {
    expect(isSensitivePath('/proj/src/index.ts')).toBe(false)
    expect(isSensitivePath('/proj/README.md')).toBe(false)
    // a file literally named gitignore is fine (not inside .git/)
    expect(isSensitivePath('/proj/.gitignore')).toBe(false)
  })
})

describe('commandTouchesSensitivePath', () => {
  test('flags commands that write sensitive paths', () => {
    expect(commandTouchesSensitivePath('rm -rf .git')).toBe(true)
    expect(commandTouchesSensitivePath('echo x > .astraea/settings.json')).toBe(true)
    expect(commandTouchesSensitivePath('echo y >> ~/.zshrc')).toBe(true)
  })
  test('does not flag ordinary commands', () => {
    expect(commandTouchesSensitivePath('git status')).toBe(false)
    expect(commandTouchesSensitivePath('npm test')).toBe(false)
    expect(commandTouchesSensitivePath('ls -la')).toBe(false)
  })
})

describe('fileWriteBehavior matrix', () => {
  test('cruise & forge auto-allow file writes', () => {
    expect(fileWriteBehavior('cruise')).toBe('allow')
    expect(fileWriteBehavior('forge')).toBe('allow')
  })
  test('default & counsel ask before writing', () => {
    expect(fileWriteBehavior('default')).toBe('ask')
    expect(fileWriteBehavior('counsel')).toBe('ask')
  })
  test('orbit denies file writes', () => {
    expect(fileWriteBehavior('orbit')).toBe('deny')
  })
})

describe('shellAskBehavior matrix', () => {
  test('forge auto-allows unmatched/ask shell', () => {
    expect(shellAskBehavior('forge')).toBe('allow')
  })
  test('every other mode asks', () => {
    expect(shellAskBehavior('default')).toBe('ask')
    expect(shellAskBehavior('cruise')).toBe('ask')
    expect(shellAskBehavior('counsel')).toBe('ask')
    expect(shellAskBehavior('orbit')).toBe('ask')
  })
})

describe('anti-escalation', () => {
  test('model may only de-escalate into orbit', () => {
    expect(isModelEnterable('orbit')).toBe(true)
    expect(isModelEnterable('cruise')).toBe(false)
    expect(isModelEnterable('forge')).toBe(false)
    expect(isModelEnterable('counsel')).toBe(false)
    expect(isModelEnterable('default')).toBe(false)
  })
})

describe('appendPermissionRule red-line guard', () => {
  test('refuses to persist an allow rule for a sensitive command', async () => {
    await expect(
      appendPermissionRule('/tmp/astraea-test-cwd', 'rm -rf .git', 'allow'),
    ).rejects.toThrow(/red-line/i)
  })
  test('session destination never writes to disk', async () => {
    // should resolve without throwing and without touching fs
    await expect(
      appendPermissionRule('/tmp/astraea-test-cwd', 'echo hi > .zshrc', 'allow', 'session'),
    ).resolves.toBeUndefined()
  })
})
