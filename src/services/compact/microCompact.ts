// Microcompact（微压缩）—— 清除旧 tool 调用的输出内容，保留调用骨架（上下文机制设计）。
// 参考源码: claude-code-main/src/services/compact/microCompact.ts（time-based 路径）。
//
// 纯机械规则、不调模型。排在 autocompact 之前：能用便宜手段腾出空间就别用贵的。
// 只 time-based 一条路径——Astraea 无消息级 prompt cache，故不移植 Cached-MC。

import type {
  AssistantMessage,
  TextBlock,
  ToolResultBlock,
  UserMessage,
} from '../../types/message'
import { getLastAssistantTs } from '../../state/microcompactState'

type Msg = UserMessage | AssistantMessage

/** 被清空的 tool_result 内容占位符。模型仍见调用骨架，只是看不到当时的输出全文。 */
export const CLEARED_MESSAGE = '[Old tool result content cleared]'

/**
 * time-based 配置。
 * - gapThresholdMinutes：距上次 assistant 消息超过这么多分钟才触发。Astraea 清消息零 cache
 *   代价，60 在这里是"staleness"阈值（离开多久后旧 tool 输出不再值得占 token），非 cache 阈值。
 * - keepRecent：按出现顺序保留最近 N 个可压缩 tool 结果，更早的清空。
 */
export const TIME_BASED_MC_CONFIG = {
  enabled: true,
  gapThresholdMinutes: 60,
  keepRecent: 2,
}

// 只对"可重新获取且丢了不致命"的工具下手——内容随时能再 Read/Grep/Bash 拿回。
// WebBrowser（有状态会话、页面会变）、Wechat（消息会滚动）、MCP（来源任意）不在内。
// 注意 Astraea 用短工具名（与各工具 index.ts 的 name 字段一致）。
const COMPACTABLE_TOOLS = new Set<string>([
  'Read',
  'Bash',
  'PowerShell',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'Edit',
  'Write',
])

export interface MicrocompactResult {
  messages: Msg[]
  cleared: boolean
  tokensSaved: number
}

// 粗略 token 估算（与项目其余处一致：chars / 4）。
function estimateContentTokens(content: string | TextBlock[]): number {
  if (typeof content === 'string') return Math.ceil(content.length / 4)
  return content.reduce((sum, b) => sum + Math.ceil((b.text?.length ?? 0) / 4), 0)
}

// 按出现顺序收集 allowlist 内工具的 tool_use id。
function collectCompactableToolIds(messages: Msg[]): string[] {
  const ids: string[] = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const block of m.content) {
      if (block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name)) {
        ids.push(block.id)
      }
    }
  }
  return ids
}

/**
 * time-based microcompact：距上次主对话 assistant 消息的 gap 超过阈值时，把除最近 N 个之外的
 * 可压缩 tool 结果内容清成占位符。原地改写消息内容（无 cache 可保），返回新数组（不可变更新）。
 *
 * 不触发（disabled / 无前置 assistant / gap 不足 / 没东西可清）时返回 cleared:false、原数组。
 * 调用方仅 query() 主循环顶部、在 autocompact 检查之前调用（且仅 compactionEnabled 主对话）。
 */
export function microcompact(messages: Msg[]): MicrocompactResult {
  const cfg = TIME_BASED_MC_CONFIG
  const noop: MicrocompactResult = { messages, cleared: false, tokensSaved: 0 }

  if (!cfg.enabled) return noop

  // ── 触发判定 ──────────────────────────────────────────────────────────────
  const last = getLastAssistantTs()
  if (last === null) return noop // 无前置 assistant（首轮 / 刚 resume 未回填）
  const gapMinutes = (Date.now() - last) / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < cfg.gapThresholdMinutes) {
    return noop
  }

  // ── 选出要清的 id：保留最近 N，清更早的 ────────────────────────────────────
  const ids = collectCompactableToolIds(messages)
  // floor 在 1：slice(-0) 会反常返回整个数组（等于什么都不清），全清又会让模型失去全部
  // 工作上下文——两个极端都不合理，至少留最近一条。
  const keepRecent = Math.max(1, cfg.keepRecent)
  const keepSet = new Set(ids.slice(-keepRecent))
  const clearSet = new Set(ids.filter(id => !keepSet.has(id)))
  if (clearSet.size === 0) return noop

  // ── 把命中的 tool_result 内容换成占位符（不可变更新 + 幂等）────────────────
  let tokensSaved = 0
  const out: Msg[] = messages.map(m => {
    if (m.role !== 'user' || typeof m.content === 'string') return m
    let touched = false
    const newContent = m.content.map(block => {
      if (
        block.type === 'tool_result' &&
        clearSet.has(block.tool_use_id) &&
        block.content !== CLEARED_MESSAGE // 幂等：已是占位符不再清
      ) {
        tokensSaved += estimateContentTokens(block.content)
        touched = true
        return { ...block, content: CLEARED_MESSAGE } as ToolResultBlock
      }
      return block
    })
    if (!touched) return m
    return { ...m, content: newContent }
  })

  if (tokensSaved === 0) return noop // 命中的都已是占位符 → 不算改动

  return { messages: out, cleared: true, tokensSaved }
}
