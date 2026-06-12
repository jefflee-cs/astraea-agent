// VigilPanel — /vigil 命令的内联帮助面板
// add / delete 项目选中后直接显示内联 TextInput，无需再按 Enter 激活

import React from 'react'
import { Box, Text } from 'ink'
import TextInput from './TextInput'

export interface VigilAction {
  key: string
  label: string
  placeholder: string
}

export const VIGIL_ACTIONS: VigilAction[] = [
  {
    key: 'add',
    label: 'add    — schedule a task',
    placeholder: '"every day at 8am, check CI" · "in 30 minutes, send report"',
  },
  {
    key: 'list',
    label: 'list   — show all tasks',
    placeholder: '',
  },
  {
    key: 'delete',
    label: 'delete — cancel by ID',
    placeholder: 'task ID',
  },
  {
    key: 'wechat',
    label: 'wechat — schedule WeChat summary',
    placeholder: 'execution time e.g. "每天晚上 10 点" · "每周一早 8 点"',
  },
]

interface VigilPanelProps {
  selectedIndex: number
  inlineValues: Record<string, string>
  onInlineChange: (key: string, value: string) => void
  onInlineSubmit: (key: string, value: string) => void
}

export function VigilPanel({ selectedIndex, inlineValues, onInlineChange, onInlineSubmit }: VigilPanelProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Text bold color="cyan">vigil — scheduled tasks</Text>
      <Text color="gray" dimColor>↑↓ move  Enter confirm  Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {VIGIL_ACTIONS.map((action, i) => {
          const isSelected = i === selectedIndex
          const hasInput = action.key !== 'list'
          return (
            <Box key={action.key}>
              <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>
                {isSelected ? ' ❯ ' : '   '}
              </Text>
              <Text color={isSelected ? 'cyan' : 'gray'} bold={isSelected}>
                {action.label}
              </Text>
              {isSelected && hasInput && (
                <Box>
                  <Text color="gray">: </Text>
                  <TextInput
                    value={inlineValues[action.key] ?? ''}
                    onChange={v => onInlineChange(action.key, v)}
                    onSubmit={v => { if (v.trim()) onInlineSubmit(action.key, v) }}
                    focus={true}
                    placeholder={action.placeholder}
                  />
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Tasks run in the background even when REPL is closed.
        </Text>
      </Box>
    </Box>
  )
}
