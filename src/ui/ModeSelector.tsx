// ModeSelector — 方向键导航 + Enter 确认的模式选择组件
// 用于 /mode 命令，不走 AI，零 token 消耗

import React from 'react'
import { Box, Text } from 'ink'
import type { SessionMode } from '../state/sessionMode'

export interface ModeOption {
  value: SessionMode
  label: string
  description: string
}

export const MODE_OPTIONS: ModeOption[] = [
  {
    value: 'orbit',
    label: 'orbit',
    description: 'read-only planning, file writes blocked',
  },
  {
    value: 'cruise',
    label: 'cruise',
    description: 'auto-accept file edits, shell still asks',
  },
  {
    value: 'forge',
    label: 'forge',
    description: 'auto-accept all changes, skip confirmations',
  },
  {
    value: 'counsel',
    label: 'counsel',
    description: 'pre-action dialogue, confirm approach first',
  },
  {
    value: 'default',
    label: 'default',
    description: 'standard permission prompts',
  },
]

const INDIGO = '#6A5ACD'

interface ModeSelectorProps {
  currentMode: SessionMode
  selectedIndex: number
}

export function ModeSelector({ currentMode, selectedIndex }: ModeSelectorProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={INDIGO}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Text bold color={INDIGO}>
        Select session mode{' '}
        <Text color="gray" dimColor>
          (current: {currentMode})
        </Text>
      </Text>
      <Text color="gray" dimColor>↑↓ move  Enter confirm  Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {MODE_OPTIONS.map((opt, i) => {
          const isSelected = i === selectedIndex
          const isCurrent = opt.value === currentMode
          return (
            <Box key={opt.value}>
              <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>
                {isSelected ? ' ❯ ' : '   '}
              </Text>
              <Text
                color={isSelected ? INDIGO : isCurrent ? 'green' : 'gray'}
                bold={isSelected}
                underline={isCurrent}
              >
                {opt.label.padEnd(8)}
              </Text>
              <Text color={isSelected ? 'white' : 'gray'} dimColor={!isSelected}>
                {'— '}{opt.description}
              </Text>
              {isCurrent && !isSelected && (
                <Text color="green" dimColor>  ✓</Text>
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
