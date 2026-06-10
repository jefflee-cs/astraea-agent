// ResumePicker — 方向键导航 + Enter 恢复历史会话的选择器（设计文档 §10 /resume picker）。
// 不走 AI、零 token，与 ModeSelector / VigilPanel 同构。

import React from 'react'
import { Box, Text } from 'ink'
import type { SessionSummary } from '../services/transcript/transcript'

const INDIGO = '#6A5ACD'
const MAX_VISIBLE = 8

function when(s: SessionSummary): string {
  const t = s.startedAt ? new Date(s.startedAt) : new Date(s.mtimeMs)
  return t.toLocaleString()
}

interface ResumePickerProps {
  sessions: SessionSummary[]
  selectedIndex: number
}

export function ResumePicker({ sessions, selectedIndex }: ResumePickerProps) {
  // 选中居中的滑动窗口
  const len = sessions.length
  const sel = Math.min(Math.max(selectedIndex, 0), Math.max(0, len - 1))
  const start = Math.max(0, Math.min(sel - Math.floor(MAX_VISIBLE / 2), Math.max(0, len - MAX_VISIBLE)))
  const visible = sessions.slice(start, start + MAX_VISIBLE)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={INDIGO} paddingX={1} marginBottom={1}>
      <Text bold color={INDIGO}>
        Resume a session{' '}
        <Text color="gray" dimColor>({len} in this directory)</Text>
      </Text>
      <Text color="gray" dimColor>↑↓ move  Enter resume  Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((s, vi) => {
          const isSelected = start + vi === sel
          const preview = s.firstUserText.length > 56 ? s.firstUserText.slice(0, 56) + '…' : s.firstUserText
          return (
            <Box key={s.sessionId}>
              <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>
                {isSelected ? ' ❯ ' : '   '}
              </Text>
              <Text color={isSelected ? INDIGO : 'gray'} bold={isSelected} dimColor={!isSelected}>
                {preview.padEnd(58)}
              </Text>
              <Text color="gray" dimColor>{when(s)}</Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
