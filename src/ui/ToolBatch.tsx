// 工具批渲染 —— 路径 A 重构（Stage 1）。
// 一个工具批 = 同一对话段里连续发生的工具调用集合，按"逐调用配对 + 同类折叠"渲染。
//   · 基础：每个 tool_use 紧跟自己的 result 作为一个视觉单元（result 按 id 回填）。
//   · 折叠：同一段里 ≥2 个同名且属于 COLLAPSE 集的调用塌缩成 "Name ×N" 一个块。
// 同一个 <ToolBatch> 既渲染 live frame 的在途批，也渲染落盘到 <Static> 的已完成批。
import React from 'react'
import { Box, Text } from 'ink'

// 一次工具调用（在途或已完成）。result 在 tool_result 事件按 id 回填。
export interface ToolCall {
  toolUseId: string
  name: string
  argText: string
  status: 'running' | 'done' | 'error'
  resultLines?: string[]  // 离开 'running' 时写入
}

// 启用"同类折叠"的工具（grill 决议：Glob/Read/Grep/Bash）。其余工具一律逐调用配对。
const COLLAPSE = new Set(['Glob', 'Read', 'Grep', 'Bash'])

interface Group {
  name: string
  collapsed: boolean
  calls: ToolCall[]
}

// 把调用序列切成"连续同名"的组；满足 折叠集 且 ≥2 个 → collapsed。
export function groupCalls(calls: ToolCall[]): Group[] {
  const groups: Group[] = []
  for (const c of calls) {
    const last = groups[groups.length - 1]
    if (last && last.name === c.name) last.calls.push(c)
    else groups.push({ name: c.name, collapsed: false, calls: [c] })
  }
  for (const g of groups) g.collapsed = g.calls.length >= 2 && COLLAPSE.has(g.name)
  return groups
}

// 结果多行块：第一行 ⎿，后续行按 +/- 上色（对齐原 tool_result 渲染）。
function ResultLines({ lines }: { lines: string[] }) {
  return (
    <Box flexDirection="column" marginLeft={4} marginBottom={1}>
      <Text color="gray" dimColor>⎿  {lines[0]}</Text>
      {lines.slice(1).map((line, i) => {
        // 工具自带 ANSI 样式（如 Edit/Write 的 diff 背景带）→ 原样输出，不再二次上色，
        // 让内嵌的 bg/fg 完全生效（与 markdown 渲染同模式：纯 <Text> 透传 ANSI）。
        if (line.includes('\x1b[')) {
          return <Text key={i}>{'   '}{line}</Text>
        }
        const t = line.trimStart()
        const isAdded = t.startsWith('+')
        const isRemoved = t.startsWith('-')
        const color = isAdded ? 'green' : isRemoved ? 'red' : 'gray'
        return (
          <Text key={i} color={color} dimColor={!isAdded && !isRemoved}>
            {'   '}{line}
          </Text>
        )
      })}
    </Box>
  )
}

// 在途工具的实时输出尾巴（tool_progress 累积，仅取末 20 行）。
function LiveOut({ text }: { text: string }) {
  return (
    <Box flexDirection="column" marginLeft={4}>
      {text.trimEnd().split('\n').slice(-20).map((line, i) => (
        <Text key={i} color="gray" dimColor>⎿  {line}</Text>
      ))}
    </Box>
  )
}

// 非折叠：经典两段式——⏺ 调用行 + 其 result 块。running 时缀 " …"。
function ToolCallRow({ call, liveOutput }: { call: ToolCall; liveOutput?: string }) {
  const running = call.status === 'running'
  return (
    <Box flexDirection="column">
      <Text color="yellow">⏺  {call.name}({call.argText}){running ? ' …' : ''}</Text>
      {!running && call.resultLines ? <ResultLines lines={call.resultLines} /> : null}
      {running && liveOutput ? <LiveOut text={liveOutput} /> : null}
    </Box>
  )
}

// 折叠：⏺ Name ×N 标题 + 每调用一行 "⎿ arg → 结果摘要"。
function CollapsedGroup({ group, liveOutput }: { group: Group; liveOutput?: string }) {
  const doneN = group.calls.filter(c => c.status !== 'running').length
  const total = group.calls.length
  const progress = doneN < total ? ` (${doneN}/${total})` : ''
  const anyRunning = doneN < total
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="yellow">⏺  {group.name} ×{total}{progress}</Text>
      {group.calls.map(c => {
        const summary = c.status === 'running' ? '…' : (c.resultLines?.[0] ?? '')
        return (
          <Text key={c.toolUseId} color="gray" dimColor>
            {'  '}⎿ {c.argText} → {summary}
          </Text>
        )
      })}
      {anyRunning && liveOutput ? <LiveOut text={liveOutput} /> : null}
    </Box>
  )
}

// 工具批：分组后，折叠组走 CollapsedGroup，其余逐调用走 ToolCallRow。
export function ToolBatch({ calls, liveOutput }: { calls: ToolCall[]; liveOutput?: string }) {
  if (calls.length === 0) return null
  const groups = groupCalls(calls)
  return (
    <Box flexDirection="column">
      {groups.map((g, gi) =>
        g.collapsed ? (
          <CollapsedGroup key={gi} group={g} liveOutput={liveOutput} />
        ) : (
          <React.Fragment key={gi}>
            {g.calls.map(c => (
              <ToolCallRow key={c.toolUseId} call={c} liveOutput={liveOutput} />
            ))}
          </React.Fragment>
        ),
      )}
    </Box>
  )
}
