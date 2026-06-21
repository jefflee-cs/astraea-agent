// SlashHint — 输入框下方的 slash 命令选择器
//
// 设计意图：输入 / 时列出可选命令，↑/↓ 高亮导航、Enter 选择、Tab 补全。
// 参考 claude-code-main/src/components/PromptInput/PromptInputFooterSuggestions.tsx：
//   · 最多可见 = Math.min(6, rows-3)，随终端高度自适应
//   · 滑动窗口·选中居中：startIndex = clamp(sel - ⌊N/2⌋, 0, len-N)
//
// enterAction 决定 Enter 时的行为（由 App.tsx 派发）：
//   execute — 零参命令，立即执行（/clear /help /model /login）
//   complete — 带参命令，补全 "/goal " 并加空格等用户输参
//   panel   — 交互式命令，打开方向键面板（/mode /vigil）

import React from 'react'
import { Box, Text, useStdout } from 'ink'

export interface SlashCommand {
  name: string         // '/mode'
  summary: string      // short action label
  options: string[]    // inline option chips, empty if none
  enterAction: 'execute' | 'complete' | 'panel'
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/mode',
    summary: 'session mode',
    options: ['orbit', 'forge', 'counsel', 'default'],
    enterAction: 'panel',
  },
  {
    name: '/goal',
    summary: 'set a completion condition to work toward',
    options: ['<condition>', 'clear'],
    enterAction: 'complete',
  },
  // /wechat —— 功能保留（App.tsx 直接路由 trimmed === '/wechat' 仍可执行），
  // 但暂不在 slash 提示里暴露，故不列入 SLASH_COMMANDS。
  {
    name: '/vigil',
    summary: 'scheduled tasks',
    options: ['add', 'list', 'delete', 'wechat'],
    enterAction: 'panel',
  },
  {
    name: '/login',
    summary: 'set API key and provider',
    options: [],
    enterAction: 'execute',
  },
  {
    name: '/internet',
    summary: 'configure web search provider',
    options: ['Bocha', 'Zhipu', 'Tavily', 'Brave', 'Exa'],
    enterAction: 'execute',
  },
  {
    name: '/language',
    summary: 'choose UI & reply language',
    options: ['English', 'Deutsch', 'Français', 'Español', '中文', '한국어'],
    enterAction: 'execute',
  },
  {
    name: '/model',
    summary: 'show current provider and model',
    options: [],
    enterAction: 'execute',
  },
  {
    name: '/reason',
    summary: 'set reasoning effort',
    options: ['low', 'medium', 'high', 'max', 'auto'],
    enterAction: 'complete',
  },
  {
    name: '/usage',
    summary: 'show session token usage & cost',
    options: [],
    enterAction: 'execute',
  },
  {
    name: '/mcp',
    summary: 'show MCP server status',
    options: [],
    enterAction: 'execute',
  },
  {
    name: '/plugin',
    summary: 'show installed plugins',
    options: [],
    enterAction: 'execute',
  },
  {
    name: '/stop',
    summary: 'stop the current task and any running agents',
    options: [],
    enterAction: 'execute',
  },
  {
    name: '/clear',
    summary: 'clear conversation history',
    options: [],
    enterAction: 'execute',
  },
  {
    name: '/compact',
    summary: 'compact context now (optional: /compact <focus>)',
    options: [],
    enterAction: 'execute',
  },
  {
    name: '/resume',
    summary: 'resume a past session (↑↓ picker)',
    options: [],
    enterAction: 'execute',
  },
  {
    name: '/rewind',
    summary: 'rewind this session — restore conversation + edited files (↑↓ picker)',
    options: [],
    enterAction: 'execute',
  },
  {
    name: '/help',
    summary: 'show available commands',
    options: [],
    enterAction: 'execute',
  },
]

const INDIGO = '#6A5ACD'

// 从统一命令表派生 slash 候选（实现文档 §1.2），覆盖两类：
//   · 用户/项目/插件 skill（prompt 类）——本就不在上方硬编码表里；
//   · 内置 local 命令（如 /usage /reason）——避免"新增内置忘了同步硬编码表"这个坑。
// 注意：local-jsx 内置（/mode /vigil 等需 panel 语义）仍由上方 SLASH_COMMANDS 精确声明，不在此派生。
// 有 argument-hint → complete（补全等输参），否则 execute。上方硬编码同名项优先（见 allSlashCommands 去重）。
function registryDerivedSlashCommands(): SlashCommand[] {
  try {
    const { getCommands } = require('../commands/registry') as typeof import('../commands/registry')
    return getCommands()
      .filter(c => c.userInvocable && !c.hidden && (
        (c.type === 'prompt' && c.source !== 'builtin') ||   // skill
        (c.type === 'local' && c.source === 'builtin')        // 内置 local（自动纳入，防遗漏）
      ))
      .map(c => ({
        name: `/${c.name}`,
        summary: c.description,
        options: c.argumentHint ? [c.argumentHint] : [],
        enterAction: (c.argumentHint ? 'complete' : 'execute') as SlashCommand['enterAction'],
      }))
  } catch {
    return []
  }
}

/** 硬编码内置 + 派生候选合并；同名以硬编码优先（它带更友好的 options/enterAction）。 */
export function allSlashCommands(): SlashCommand[] {
  const hardcoded = new Set(SLASH_COMMANDS.map(c => c.name))
  const derived = registryDerivedSlashCommands().filter(c => !hardcoded.has(c.name))
  return [...SLASH_COMMANDS, ...derived]
}

// 前缀匹配 + 声明顺序；input === '/' 时列出全部。精确匹配也保留（单一路径）。
export function matchSlashCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/') || input.includes(' ')) return []
  return allSlashCommands().filter(c => c.name.startsWith(input))
}

interface SlashHintProps {
  input: string
  selectedIndex: number
}

export function SlashHint({ input, selectedIndex }: SlashHintProps) {
  const { stdout } = useStdout()
  const matches = matchSlashCommands(input)
  if (matches.length === 0) return null

  // 最多可见 = min(6, rows-3)，随终端高度限制（参考 claude-code inline 模式）
  const rows = stdout?.rows ?? 24
  const maxVisible = Math.min(6, Math.max(1, rows - 3))

  // 滑动窗口·选中居中：高亮项尽量保持在窗口中部
  const len = matches.length
  const sel = Math.min(Math.max(selectedIndex, 0), len - 1)
  const startIndex = Math.max(0, Math.min(sel - Math.floor(maxVisible / 2), len - maxVisible))
  const endIndex = Math.min(startIndex + maxVisible, len)
  const visible = matches.slice(startIndex, endIndex)

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={0}>
      {visible.map((cmd, vi) => {
        const isSelected = startIndex + vi === sel
        return (
          <Box key={cmd.name} flexDirection="row">
            <Text color={isSelected ? INDIGO : 'gray'} bold={isSelected}>
              {isSelected ? ' ❯ ' : '   '}
            </Text>
            <Text color={isSelected ? INDIGO : 'gray'} bold={isSelected} dimColor={!isSelected}>
              {cmd.name.padEnd(10)}
            </Text>
            <Text color="gray" dimColor>
              {cmd.options.length > 0 ? cmd.options.join(' · ') : cmd.summary}
            </Text>
          </Box>
        )
      })}
      <Text color="gray" dimColor>
        {'   '}↑↓ navigate · Enter select · Tab complete
      </Text>
    </Box>
  )
}
