// ThinkingIndicator — Astraea 思考中的动态指示器
//
// 取代静态的 "✦ Thinking..."：每次思考都从一句随机的、星之女神主题的短语开始，
// 思考期间短语会缓慢轮换，前导星符也会闪烁 —— 既优雅又不单调。

import React, { useEffect, useState } from 'react'
import { Text } from 'ink'

const INDIGO = '#6A5ACD'
const SILVER = '#C8D8FF'

// 星之女神（掌管星辰与正义）主题的"工作中"短语 —— 思考时轮换，避免静态感。
const PHRASES: string[] = [
  'Consulting the stars',
  'Charting the constellations',
  'Reading the night sky',
  'Aligning the heavens',
  'Weighing the scales',
  'Gathering starlight',
  'Tracing the zodiac',
  'Listening to the dark',
  'Summoning clarity',
  'Threading the cosmos',
  'Calling on Virgo',
  'Letting the stars settle',
  'Measuring the moment',
  'Turning it over',
  'Drawing the constellation',
  'Tilting toward the light',
]

// 前导星符的闪烁帧 —— 一圈缓慢的微光。
const STARS = ['✦', '✧', '⋆', '✩', '⋆', '✧']

const TICK_MS = 140          // 帧间隔
const TICKS_PER_PHRASE = 16  // 约 2.2s 换一句

export function ThinkingIndicator(): React.ReactNode {
  // 随机起始短语：每次进入"思考"都焕然一新。
  const [startIdx] = useState(() => Math.floor(Math.random() * PHRASES.length))
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const star = STARS[tick % STARS.length]
  const phrase = PHRASES[(startIdx + Math.floor(tick / TICKS_PER_PHRASE)) % PHRASES.length]
  const dots = '.'.repeat(tick % 4)

  return (
    <Text>
      <Text color={SILVER}>{star} </Text>
      <Text color={INDIGO} italic>{phrase}</Text>
      <Text color={INDIGO} dimColor>{dots}</Text>
    </Text>
  )
}

// 把 token 数压缩成 "1.2k" / "938" 形式。
function fmtTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000
    return (k >= 10 ? Math.round(k).toString() : k.toFixed(1).replace(/\.0$/, '')) + 'k'
  }
  return String(n)
}

// StreamStatus —— 流式运行期间**常驻**的状态行（取代仅空闲时出现的 ThinkingIndicator）。
//
// 解决"agent 跑到一半停住、用户不知是否还在运行"的问题：只要在流式中就一直显示
//   ✦ <轮换短语>… (1.2k tokens · 37s · esc to interrupt)
// 闪烁的星 + 轮换短语 + 实时秒数共同证明"还活着"；token 数随输出累积实时攀升。
export function StreamStatus({
  startTime,
  tokens,
}: {
  startTime: number | null  // 本次流式开始时刻（null = 尚未开始）
  tokens: number            // 本次运行的实时输出 token 估算（>0 才显示）
}): React.ReactNode {
  const [startIdx] = useState(() => Math.floor(Math.random() * PHRASES.length))
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const star = STARS[tick % STARS.length]
  const phrase = PHRASES[(startIdx + Math.floor(tick / TICKS_PER_PHRASE)) % PHRASES.length]
  const elapsed = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0

  const meta: string[] = []
  if (tokens > 0) meta.push(`${fmtTokens(tokens)} tokens`)
  meta.push(`${elapsed}s`)
  meta.push('esc to interrupt')

  return (
    <Text>
      <Text color={SILVER}>{star} </Text>
      <Text color={INDIGO} italic>{phrase}</Text>
      <Text color={INDIGO} dimColor>…  ({meta.join(' · ')})</Text>
    </Text>
  )
}
