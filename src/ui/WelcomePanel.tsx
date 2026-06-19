import React from 'react'
import { Box, Text, useStdout } from 'ink'
import { AstraeaSprite } from './AstraeaSprite'
import { AstraeaWordmark, fitsWordmark } from './AstraeaWordmark'

const INDIGO = '#6A5ACD'
const SILVER = '#C8D8FF'
const DIM = '#7A8AAA'

// CJK chars are double-width; count actual terminal columns for a string
function visWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    // CJK Unified Ideographs, CJK Compatibility Ideographs, Fullwidth forms, etc.
    w += cp >= 0x1100 && (
      cp <= 0x115F || cp === 0x2329 || cp === 0x232A ||
      (cp >= 0x2E80 && cp <= 0x303E) ||
      (cp >= 0x3040 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE10 && cp <= 0xFE19) ||
      (cp >= 0xFE30 && cp <= 0xFE6F) ||
      (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x1F300 && cp <= 0x1F64F) ||
      (cp >= 0x1F900 && cp <= 0x1F9FF) ||
      (cp >= 0x20000 && cp <= 0x2FFFD) ||
      (cp >= 0x30000 && cp <= 0x3FFFD)
    ) ? 2 : 1
  }
  return w
}

interface Props {
  version: string
  cwd: string
  model: string
  tools: string[]
}

export function WelcomePanel({ version, cwd, model, tools }: Props): React.ReactNode {
  const { stdout } = useStdout()
  const columns = stdout?.columns ?? 80
  // 渲染宽度留 1 列：占满整行（=columns）的边框/Box 在 Windows 终端会自动换行，
  // 多占一行物理行，导致 Ink 重绘错位、卡片被撑歪/重影（issue「Windows 表格格式有问题」）。
  // 仅用于实际绘制；twoCol / fitsWordmark 这类布局判断仍用真实 columns。
  const panelW = Math.max(1, columns - 1)

  const twoCol = columns >= 64

  const toolLine = tools.slice(0, 3).join(', ') + (tools.length > 3 ? ' …' : '')
  const truncCwd = cwd.length > 38 ? '…' + cwd.slice(cwd.length - 37) : cwd

  // Title border — '╭' at col 0, '╮' at col panelW-1, total = panelW chars
  const tag = ` Astraea v${version} `
  const dashes = '─'.repeat(Math.max(0, panelW - 3 - visWidth(tag)))
  const topBorder = `╭─${tag}${dashes}╮`
  const botBorder = `╰${'─'.repeat(Math.max(0, panelW - 2))}╯`

  // Left panel is 24 terminal cols wide (sprite is ~9 wide, subtitle is "星之女神 · AI" = 14 wide)
  const LEFT_W = 24

  return (
    <Box flexDirection="column">
      {/* 启动扫光动画的"定格"——银色扫过后留下的纯靛蓝大字标识，常驻在卡片上方。 */}
      {fitsWordmark(columns) && (
        <Box marginBottom={1}>
          <AstraeaWordmark />
        </Box>
      )}
      <Text color={INDIGO}>{topBorder}</Text>

      <Box
        borderStyle="single"
        borderColor={INDIGO}
        borderTop={false}
        borderBottom={false}
        flexDirection={twoCol ? 'row' : 'column'}
        paddingX={1}
        paddingY={1}
        width={panelW}
      >
        {/* Left panel: sprite + subtitle */}
        <Box
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          width={twoCol ? LEFT_W : undefined}
          minHeight={7}
          flexShrink={0}
        >
          <AstraeaSprite />
          <Box marginTop={1} flexDirection="column" alignItems="center">
            <Text color={SILVER} bold>Astraea</Text>
            <Text color={INDIGO} dimColor>{'· ✦ · ✧ · ✦ ·'}</Text>
            <Text color={DIM}>{'星之女神'}</Text>
          </Box>
        </Box>

        {/* Vertical divider */}
        {twoCol && (
          <Box
            height="100%"
            borderStyle="single"
            borderColor={INDIGO}
            borderDimColor
            borderTop={false}
            borderBottom={false}
            borderLeft={false}
            marginX={1}
          />
        )}

        {/* Right panel */}
        {twoCol && (
          <Box flexDirection="column" justifyContent="center" paddingLeft={1} gap={0}>
            <Box flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={SILVER}>{'✦ '}</Text>
                <Text color={SILVER} italic>{'You speak, I understand · You imagine, I assist · You build, I\'m here.'}</Text>
              </Box>
              <Box>
                <Text color={INDIGO} dimColor>{'✧ '}</Text>
                <Text color={DIM} italic>{'Order is not constraint — it\'s the foundation of freedom.'}</Text>
              </Box>
              <Box>
                <Text color={INDIGO} dimColor>{'⋆ '}</Text>
                <Text color={DIM}>{'Building a better life, together.'}</Text>
              </Box>
            </Box>
            <Box>
              <Text color={DIM}>{'model  '}</Text>
              <Text color={SILVER}>{model}</Text>
            </Box>
            <Box>
              <Text color={DIM}>{'dir    '}</Text>
              <Text>{truncCwd}</Text>
            </Box>
            <Box>
              <Text color={DIM}>{'tools  '}</Text>
              <Text color={DIM}>{toolLine}</Text>
            </Box>
            <Box marginTop={1}>
              <Text color={DIM} dimColor>{'✦ message · Ctrl+C exit'}</Text>
            </Box>
          </Box>
        )}
      </Box>

      <Text color={INDIGO}>{botBorder}</Text>
    </Box>
  )
}
