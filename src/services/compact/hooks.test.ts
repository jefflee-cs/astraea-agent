import { test, expect } from 'bun:test'
import { runHookCommand } from './hooks'

test('runHookCommand: stdin 收到 JSON payload，stdout 回传', async () => {
  // cat 把 stdin 原样吐到 stdout → 验证 payload 经 stdin 传入
  const out = await runHookCommand('cat', { trigger: 'auto', customInstructions: 'focus X' }, 5_000)
  const parsed = JSON.parse(out)
  expect(parsed.trigger).toBe('auto')
  expect(parsed.customInstructions).toBe('focus X')
})

test('runHookCommand: 普通 stdout 文本回传', async () => {
  const out = await runHookCommand('echo hello-hook', {}, 5_000)
  expect(out.trim()).toBe('hello-hook')
})

test('runHookCommand: 非零退出 → 丢弃输出（非致命）', async () => {
  const out = await runHookCommand('echo nope; exit 1', {}, 5_000)
  expect(out).toBe('')
})

test('runHookCommand: 超时被杀 → 返回空串（非致命，不抛）', async () => {
  // 内部 200ms 超时即返回 ''；给 bun 一个宽松的单测超时，避免负载下的时序 flake。
  const out = await runHookCommand('sleep 5; echo late', {}, 200)
  expect(out).toBe('')
}, 15_000)

test('runHookCommand: 命令本身报错也不抛', async () => {
  const out = await runHookCommand('this-binary-does-not-exist-xyz', {}, 2_000)
  expect(out).toBe('')
})
