// TodoPanel 行为回归测试 —— 锁定「任务结束后没有终止提示」修复。
//
// 根因：终止提示（✓ 全部完成 + 1.5s 后清空）只在所有 todo 都 completed 时触发。
// 模型干完活、报告完成、却忘了发收尾 TodoWrite 时，最后一条 todo 停在 in_progress，
// 面板永远挂着旋转的 ◉ 而没有任何终止态。修复：主 Agent 空闲（idle）且仍有未完成
// todo 时，渲染静态「已暂停」终止提示，并把 ◉ 换成 ⏸。

import React from 'react'
import { test, expect, afterEach } from 'bun:test'
import { render } from 'ink-testing-library'
import { TodoPanel } from './TodoPanel'
import { setTodos, clearTodos } from '../services/todo-state'
import { setLocale } from '../i18n'

const NS = 'main'
const strip = (s: string | undefined) => (s ?? '').replace(/\[[0-9;]*m/g, '')
const tick = () => new Promise((r) => setTimeout(r, 350)) // > POLL_MS(300)

afterEach(() => clearTodos(NS))

test('idle 且仍有 in_progress todo → 显示「已暂停」终止提示，◉ 变 ⏸', async () => {
  setLocale('zh')
  setTodos([{ id: '1', content: '重写完整HTML文件', status: 'in_progress', priority: 'high' }], NS)

  const { lastFrame } = render(<TodoPanel idle={true} />)
  await tick()

  const frame = strip(lastFrame())
  expect(frame).toContain('⏸')            // 静态暂停图标
  expect(frame).toContain('已暂停')        // 终止提示文案
  expect(frame).not.toContain('◉')        // 不再渲染旋转态
})

test('streaming 中（idle=false）保持 ◉，不显示暂停提示', async () => {
  setLocale('zh')
  setTodos([{ id: '1', content: '重写完整HTML文件', status: 'in_progress' }], NS)

  const { lastFrame } = render(<TodoPanel idle={false} />)
  await tick()

  const frame = strip(lastFrame())
  expect(frame).toContain('◉')
  expect(frame).not.toContain('已暂停')
})

test('全部 completed → 走原有 ✓ 终止提示，不显示暂停', async () => {
  setLocale('zh')
  setTodos([{ id: '1', content: '重写完整HTML文件', status: 'completed' }], NS)

  const { lastFrame } = render(<TodoPanel idle={true} />)
  await tick()

  const frame = strip(lastFrame())
  expect(frame).toContain('✓')
  expect(frame).not.toContain('已暂停')
})

test('进入全部完成的瞬间 onComplete 触发一次并带任务数（用于持久化进历史）', async () => {
  setLocale('zh')
  const calls: number[] = []
  // 起始有一条未完成 → 渲染后再标完成，制造 allDone 的「转变」
  setTodos([{ id: '1', content: '重写完整HTML文件', status: 'in_progress' }], NS)

  render(<TodoPanel idle={false} onComplete={(n) => calls.push(n)} />)
  await tick()
  expect(calls.length).toBe(0)         // 还没全完成，不触发

  setTodos([{ id: '1', content: '重写完整HTML文件', status: 'completed' }], NS)
  await tick()
  expect(calls).toEqual([1])           // 转变那一刻触发一次，带任务数 1

  await tick()
  expect(calls).toEqual([1])           // 后续轮询不重复触发
})
