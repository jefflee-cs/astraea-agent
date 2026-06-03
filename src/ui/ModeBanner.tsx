// ModeBanner — 模式横幅组件
//
// ModeInputFrame:  在输入框上下各渲染一条横线，模式标签嵌在上边横线中央
//                  参考 Claude Code PromptInput 的 swarm banner 模式
// ModeSwitchBanner: 写入 history 的一次性切换记录（scrollback 里可查）

import React from 'react'
import { Box, Text, useStdout } from 'ink'
import type { SessionMode } from '../state/sessionMode'

const INDIGO = '#6A5ACD'

export const MODE_META: Record<SessionMode, {
  label: string
  tagline: string
  color: string
  dim: boolean
}> = {
  orbit:   { label: 'orbit',   tagline: 'blueprint mode — file writes blocked',           color: 'cyan',    dim: false },
  cruise:  { label: 'cruise',  tagline: 'autopilot mode — edits auto-accepted, shell asks', color: 'green',  dim: false },
  forge:   { label: 'forge',   tagline: 'execution mode — all changes auto-accepted',     color: 'yellow',  dim: false },
  counsel: { label: 'counsel', tagline: 'dialogue mode — confirm approach before acting', color: 'magenta', dim: false },
  default: { label: 'default', tagline: 'standard mode',                                  color: 'gray',    dim: true  },
}

// ── 输入框上下横线包裹 ──────────────────────────────────────────────────────
interface ModeInputFrameProps {
  mode: SessionMode
  children: React.ReactNode
}

export function ModeInputFrame({ mode, children }: ModeInputFrameProps) {
  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 80
  const meta = MODE_META[mode]

  // 上边横线：模式标签嵌在中间
  // 格式: ─── label: tagline ───────────────────
  const label = ` ${meta.label}: ${meta.tagline} `
  const totalDashes = Math.max(0, cols - label.length)
  const dashLeft  = 2
  const dashRight = Math.max(0, totalDashes - dashLeft)
  const topLine = '─'.repeat(dashLeft) + label + '─'.repeat(dashRight)

  // 下边横线：纯横线
  const botLine = '─'.repeat(cols)

  return (
    <Box flexDirection="column">
      <Text color={meta.color} dimColor={meta.dim}>{topLine}</Text>
      {children}
      <Text color={meta.color} dimColor={meta.dim}>{botLine}</Text>
    </Box>
  )
}

// ── history 里的一次性切换记录（scrollback 可查，设计为低调）────────────────
interface ModeSwitchBannerProps {
  mode: SessionMode
}

export function ModeSwitchBanner({ mode }: ModeSwitchBannerProps) {
  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 80
  const meta = MODE_META[mode]

  const inner = ` switched to ${meta.label} `
  const dashes = Math.max(0, cols - inner.length)
  const left = Math.floor(dashes / 2)
  const right = dashes - left
  const line = '─'.repeat(left) + inner + '─'.repeat(right)

  return (
    <Box marginY={0}>
      <Text color={meta.color} dimColor>{line}</Text>
    </Box>
  )
}
