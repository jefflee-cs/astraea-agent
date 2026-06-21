// RewindPicker — 方向键导航 + Enter 回滚到某个会话内检查点（/rewind）。
// 与 ResumePicker 同构（零 token、纯本地）；语义不同：回滚「当前会话」到第 N 回合之前，
// 连同 Write/Edit 改过的文件一起倒回。最新回合显示在最上方。

import React from 'react'
import { Box, Text } from 'ink'
import type { Checkpoint } from '../services/rewind/checkpointStore'

const AMBER = '#d08770'
const MAX_VISIBLE = 8

function when(c: Checkpoint): string {
  return new Date(c.createdAt).toLocaleTimeString()
}

interface RewindPickerProps {
  checkpoints: Checkpoint[]
  selectedIndex: number
}

export function RewindPicker({ checkpoints, selectedIndex }: RewindPickerProps) {
  const len = checkpoints.length
  const sel = Math.min(Math.max(selectedIndex, 0), Math.max(0, len - 1))
  const start = Math.max(0, Math.min(sel - Math.floor(MAX_VISIBLE / 2), Math.max(0, len - MAX_VISIBLE)))
  const visible = checkpoints.slice(start, start + MAX_VISIBLE)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={AMBER} paddingX={1} marginBottom={1}>
      <Text bold color={AMBER}>
        Rewind to a checkpoint{' '}
        <Text color="gray" dimColor>({len} turn{len === 1 ? '' : 's'} in this session)</Text>
      </Text>
      <Text color="gray" dimColor>↑↓ move  Enter rewind  Esc cancel  ·  restores conversation + edited files</Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((c, vi) => {
          const isSelected = start + vi === sel
          const preview = c.userText.length > 52 ? c.userText.slice(0, 52) + '…' : c.userText
          return (
            <Box key={c.turn}>
              <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>
                {isSelected ? ' ❯ ' : '   '}
              </Text>
              <Text color="gray" dimColor>{`#${c.turn}`.padEnd(5)}</Text>
              <Text color={isSelected ? AMBER : 'gray'} bold={isSelected} dimColor={!isSelected}>
                {preview.padEnd(54)}
              </Text>
              <Text color="gray" dimColor>{when(c)}</Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
