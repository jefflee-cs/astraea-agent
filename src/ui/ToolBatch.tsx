// 工具批渲染 —— 路径 A 重构（Stage 1）。
// 一个工具批 = 同一对话段里连续发生的工具调用集合，按"逐调用配对 + 同类折叠"渲染。
//   · 基础：每个 tool_use 紧跟自己的 result 作为一个视觉单元（result 按 id 回填）。
//   · 折叠：同一段里 ≥2 个同名且属于 COLLAPSE 集的调用塌缩成 "Name ×N" 一个块。
// 同一个 <ToolBatch> 既渲染 live frame 的在途批，也渲染落盘到 <Static> 的已完成批。
import React from 'react'
import { Box, Text } from 'ink'
import { toolStatusColor, aggregateStatusColor } from './theme'

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
  // 拍平内嵌换行：像 Glob 这类无 renderResult 的工具，整段结果是「一个含 \n 的字符串」，
  // 若不拆开，那些续行会落回 marginLeft 基线（第 4 列）而不是对齐到 ⎿ 内容（第 7 列），
  // 形成参差。拆成「每物理行一个元素」后，首行画 ⎿、续行统一 3 空格悬挂缩进 → 内容齐第 7 列。
  const flat = lines.flatMap(l => l.split('\n'))
  return (
    <Box flexDirection="column" marginLeft={4} marginBottom={1}>
      {flat.map((line, i) => {
        const prefix = i === 0 ? '⎿  ' : '   '
        // 工具自带 ANSI 样式（如 Edit/Write 的 diff 背景带）→ 原样输出，不再二次上色，
        // 让内嵌的 bg/fg 完全生效（与 markdown 渲染同模式：纯 <Text> 透传 ANSI）。
        if (line.includes('\x1b[')) {
          return <Text key={i}>{prefix}{line}</Text>
        }
        const t = line.trimStart()
        const isAdded = t.startsWith('+')
        const isRemoved = t.startsWith('-')
        const color = isAdded ? 'green' : isRemoved ? 'red' : 'gray'
        return (
          <Text key={i} color={color} dimColor={!isAdded && !isRemoved} wrap="truncate-end">
            {prefix}{line}
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
  // 调用头按状态色矩阵上色：running 黄（进行中）· done 绿（已落盘）· error 红（失败）。
  return (
    <Box flexDirection="column">
      <Text color={toolStatusColor(call.status)} wrap="truncate-end">⏺  {call.name}({call.argText}){running ? ' …' : ''}</Text>
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
  // 折叠组的聚合色：任一失败 → 红，否则任一在跑 → 黄，全部完成 → 绿。
  const headColor = aggregateStatusColor(group.calls.map(c => c.status))
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={headColor} wrap="truncate-end">⏺  {group.name} ×{total}{progress}</Text>
      {/* ⎿ 统一缩进到第 4 列，与非折叠的 ResultLines 对齐（trace 1：折叠 2 格/普通 4 格不一致）。 */}
      <Box flexDirection="column" marginLeft={4}>
        {group.calls.map(c => {
          const summary = c.status === 'running' ? '…' : (c.resultLines?.[0] ?? '')
          return (
            <Text key={c.toolUseId} color="gray" dimColor wrap="truncate-end">
              ⎿ {c.argText} → {summary}
            </Text>
          )
        })}
      </Box>
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
