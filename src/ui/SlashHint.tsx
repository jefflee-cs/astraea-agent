// SlashHint — 输入框下方的 slash 命令补全提示
//
// 设计意图：用户看到提示就知道补全后能选什么，不用盲打。
//
// 示例：
//   输入 /mo  →  /mode   orbit · forge · counsel · default    Tab to complete
//   输入 /vi  →  /vigil  add · list · delete                  Tab to complete
//   输入 /l   →  /login  set API key and provider             Tab to complete

import React from 'react'
import { Box, Text } from 'ink'

export interface SlashCommand {
  name: string         // '/mode'
  summary: string      // short action label
  options: string[]    // inline option chips, empty if none
  interactive?: boolean // opens an interactive selector on Enter
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/mode',
    summary: 'session mode',
    options: ['orbit', 'forge', 'counsel', 'default'],
    interactive: true,
  },
  {
    name: '/goal',
    summary: 'set a completion condition to work toward',
    options: ['<condition>', 'clear'],
  },
  {
    name: '/wechat',
    summary: 'summarize WeChat chats now',
    options: [],
  },
  {
    name: '/vigil',
    summary: 'scheduled tasks',
    options: ['add', 'list', 'delete', 'wechat'],
  },
  {
    name: '/login',
    summary: 'set API key and provider',
    options: [],
  },
  {
    name: '/model',
    summary: 'show current provider and model',
    options: [],
  },
  {
    name: '/clear',
    summary: 'clear conversation history',
    options: [],
  },
  {
    name: '/help',
    summary: 'show available commands',
    options: [],
  },
]

interface SlashHintProps {
  input: string
}

export function SlashHint({ input }: SlashHintProps) {
  // 只在纯命令前缀时显示（有空格说明用户已在输入参数，不再提示）
  if (!input.startsWith('/') || input.includes(' ')) return null

  // 输入仅 '/' 时列出所有命令；
  // 否则过滤前缀匹配 — interactive 命令在精确匹配时也保留（需提示 Enter to select）
  const matches = input === '/'
    ? SLASH_COMMANDS
    : SLASH_COMMANDS.filter(c => c.name.startsWith(input) && (c.name !== input || c.interactive))

  if (matches.length === 0) return null

  const isExactMatch = (cmd: SlashCommand) => input !== '/' && cmd.name === input
  const showTab = input !== '/' && matches.length === 1 && !isExactMatch(matches[0]!)

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={0}>
      {matches.map(cmd => (
        <Box key={cmd.name} flexDirection="row">
          {/* 命令名：已输入部分高亮，待补全部分灰色 */}
          <Text color="cyan" bold>{input === '/' ? cmd.name : input}</Text>
          {input !== '/' && (
            <Text color="cyan" dimColor>{cmd.name.slice(input.length)}</Text>
          )}

          {/* 子选项 chips 或简短说明 */}
          <Text color="gray" dimColor>{'  '}</Text>
          {cmd.options.length > 0 ? (
            <Text color="gray" dimColor>{cmd.options.join(' · ')}</Text>
          ) : (
            <Text color="gray" dimColor>{cmd.summary}</Text>
          )}

          {/* 补全提示 + interactive 命令显示 Enter to select */}
          {(showTab || (cmd.interactive && matches.length === 1)) && (
            <>
              <Text color="gray" dimColor>{'   '}</Text>
              {showTab && <Text color="gray" dimColor>Tab to complete</Text>}
              {cmd.interactive && (
                <>
                  {showTab && <Text color="gray" dimColor>{'  '}</Text>}
                  <Text color="gray" dimColor>Enter to select</Text>
                </>
              )}
            </>
          )}
        </Box>
      ))}
    </Box>
  )
}
