import { test, expect } from 'bun:test'
import { hasMemoryWritesSince } from './extract'
import { getMemoryBaseDir } from './paths'
import type { AssistantMessage, UserMessage } from '../types/message'

const memFile = `${getMemoryBaseDir()}/projects/slug/memory/feedback_testing.md`
const nonMem = '/tmp/some/other/file.ts'

function asst(toolName: string, filePath: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'x', name: toolName, input: { file_path: filePath, content: 'c' } }],
  }
}

const userMsg: UserMessage = { role: 'user', content: 'hi' }

test('hasMemoryWritesSince: 主代理 Write 记忆文件 → true', () => {
  const msgs = [userMsg, asst('Write', memFile)]
  expect(hasMemoryWritesSince(msgs, 0)).toBe(true)
})

test('hasMemoryWritesSince: Edit 记忆文件 → true', () => {
  expect(hasMemoryWritesSince([asst('Edit', memFile)], 0)).toBe(true)
})

test('hasMemoryWritesSince: 写非记忆文件 → false', () => {
  expect(hasMemoryWritesSince([asst('Write', nonMem)], 0)).toBe(false)
})

test('hasMemoryWritesSince: 游标之前的写不算', () => {
  const msgs = [asst('Write', memFile), userMsg]
  // 从 index 1 起看，前面那条记忆写被游标跳过
  expect(hasMemoryWritesSince(msgs, 1)).toBe(false)
})

test('hasMemoryWritesSince: 无写 → false', () => {
  expect(hasMemoryWritesSince([userMsg, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }], 0)).toBe(false)
})
