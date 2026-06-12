import { test, expect } from 'bun:test'
import { groupCalls, type ToolCall } from './ToolBatch'

const call = (name: string, id: string, status: ToolCall['status'] = 'done'): ToolCall => ({
  toolUseId: id,
  name,
  argText: `${name}-arg`,
  status,
  resultLines: ['ok'],
})

test('groupCalls: 同名连续 ≥2 且属折叠集 → collapsed', () => {
  const groups = groupCalls([call('Glob', '1'), call('Glob', '2'), call('Glob', '3')])
  expect(groups).toHaveLength(1)
  expect(groups[0]!.collapsed).toBe(true)
  expect(groups[0]!.calls).toHaveLength(3)
})

test('groupCalls: 单个折叠集工具不折叠（需 ≥2）', () => {
  const groups = groupCalls([call('Read', '1')])
  expect(groups).toHaveLength(1)
  expect(groups[0]!.collapsed).toBe(false)
})

test('groupCalls: 非折叠集工具即便连续也不折叠', () => {
  const groups = groupCalls([call('Write', '1'), call('Write', '2')])
  expect(groups[0]!.collapsed).toBe(false)
  expect(groups[0]!.calls).toHaveLength(2)
})

test('groupCalls: 不同名打断分组', () => {
  const groups = groupCalls([
    call('Glob', '1'), call('Glob', '2'),
    call('Read', '3'),
    call('Glob', '4'), call('Glob', '5'),
  ])
  expect(groups).toHaveLength(3)
  expect(groups[0]!.collapsed).toBe(true)   // Glob ×2
  expect(groups[1]!.collapsed).toBe(false)  // Read ×1
  expect(groups[2]!.collapsed).toBe(true)   // Glob ×2
})

test('groupCalls: 混合 Glob/Read/Grep/Bash 各自折叠', () => {
  const groups = groupCalls([
    call('Bash', '1'), call('Bash', '2'),
    call('Grep', '3'), call('Grep', '4'),
  ])
  expect(groups).toHaveLength(2)
  expect(groups.every(g => g.collapsed)).toBe(true)
})

test('groupCalls: running 调用也计入分组', () => {
  const groups = groupCalls([call('Glob', '1', 'done'), call('Glob', '2', 'running')])
  expect(groups[0]!.collapsed).toBe(true)
  expect(groups[0]!.calls.map(c => c.status)).toEqual(['done', 'running'])
})

test('groupCalls: 空输入 → 空数组', () => {
  expect(groupCalls([])).toEqual([])
})
