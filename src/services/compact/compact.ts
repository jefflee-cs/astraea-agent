// 客户端压缩核心（设计文档 §5.2/§7/§8）。
//
// 流程：min 门槛守卫 → streamCompactSummary（摘要请求自身 PTL 截头重试 ≤3 + 流式瞬时重试 2）
//      → 提取 <summary> → 按落点预算选最近逐字消息 → 重建 [摘要 + 最近] → 估算 willRetrigger。
// 压缩是直接 streamMessage 调用（非递归 query），所以不会触发嵌套 autocompact。

import { streamMessage } from '../../api/stream'
import { activeMaxTokens } from '../../config'
import type { Message, UserMessage, AssistantMessage } from '../../types/message'
import { createUserMessage } from '../../types/message'
import {
  buildCompactSystemPrompt,
  buildCompactUserMessage,
  extractSummary,
} from './compactPrompt'
import { activeThresholds, landingTarget } from './window'
import { runPreCompactHook, runPostCompactHook } from './hooks'

type ConvMessage = UserMessage | AssistantMessage

const MAX_PTL_RETRIES = 3
const MAX_STREAMING_RETRIES = 2
const PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]'
// 最小压缩门槛：太短的对话压了无益（manual /compact 在小对话上的守卫）。
const MIN_MESSAGES_TO_COMPACT = 4

// ── token 估算（chars/4）─────────────────────────────────────────────────────
// 触发判定用的是 API 真值；但"压缩后假想状态"还没发出去拿不到 usage，只能本地估算。
export function estimateTokens(messages: Message[]): number {
  let chars = 0
  for (const m of messages) chars += messageChars(m)
  return Math.ceil(chars / 4)
}

function messageChars(m: Message): number {
  if (typeof m.content === 'string') return m.content.length
  let c = 0
  for (const b of m.content) {
    if (b.type === 'text') c += b.text.length
    else if (b.type === 'tool_use') c += b.name.length + JSON.stringify(b.input).length
    else if (b.type === 'tool_result') {
      c += typeof b.content === 'string'
        ? b.content.length
        : b.content.reduce((s, x) => s + ('text' in x ? x.text.length : 0), 0)
    }
  }
  return c
}

// ── 各 provider 溢出错误归一（设计文档 §8）──────────────────────────────────
const OVERFLOW_PATTERNS = [
  'prompt is too long',
  'prompt_too_long',
  'context_length_exceeded',
  'maximum context length',
  'model_context_window_exceeded',
  'too many tokens',
  'reduce the length',
  'input length',
]

export function isOverflowError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (msg.includes('413')) return true
  return OVERFLOW_PATTERNS.some(p => msg.includes(p))
}

// ── 压缩自身的鲁棒性：摘要请求 PTL 时截掉最老的几轮 ──────────────────────────
export function truncateHeadForPTLRetry(messages: ConvMessage[]): ConvMessage[] {
  // 已经是截断过的：再砍掉更多（去掉开头那条 marker + 之后一截）。
  const hasMarker =
    messages[0]?.role === 'user' &&
    typeof messages[0].content !== 'string' &&
    messages[0].content.some(b => b.type === 'text' && b.text === PTL_RETRY_MARKER)
  const body = hasMarker ? messages.slice(1) : messages
  // 砍掉前 1/3（至少 2 条），保留尾部最近内容。
  const drop = Math.max(2, Math.floor(body.length / 3))
  const kept = sanitizeRecent(body.slice(drop))
  const marker: UserMessage = { role: 'user', content: [{ type: 'text', text: PTL_RETRY_MARKER }] }
  return [marker, ...kept]
}

// ── 最近逐字保留：去掉孤儿 tool_result（其 tool_use 不在切片内会触发 API 400）──
function sanitizeRecent(recent: ConvMessage[]): ConvMessage[] {
  const seenToolUse = new Set<string>()
  for (const m of recent) {
    if (m.role === 'assistant' && typeof m.content !== 'string') {
      for (const b of m.content) if (b.type === 'tool_use') seenToolUse.add(b.id)
    }
  }
  const out: ConvMessage[] = []
  for (const m of recent) {
    if (m.role === 'user' && typeof m.content !== 'string') {
      const filtered = m.content.filter(
        b => b.type !== 'tool_result' || seenToolUse.has(b.tool_use_id),
      )
      if (filtered.length === 0) continue // 整条都是孤儿 tool_result → 丢弃
      out.push({ ...m, content: filtered })
    } else {
      out.push(m)
    }
  }
  return out
}

/** 按落点预算从尾部选最近消息；底线：至少保留最近若干条（最近 1–2 个 turn）。 */
export function selectRecentMessages(
  messages: ConvMessage[],
  budgetTokens: number,
): ConvMessage[] {
  const FLOOR = 4 // 最近 1–2 个 turn 的硬底线（user+assistant+toolresult 约 2~4 条）
  let acc = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += messageChars(messages[i]!) / 4
    start = i
    if (acc >= budgetTokens && messages.length - i >= FLOOR) break
  }
  // 保证底线条数
  start = Math.min(start, Math.max(0, messages.length - FLOOR))
  return sanitizeRecent(messages.slice(start))
}

/** 重建压缩后的消息：摘要作首条 user 消息（带标签）+ 最近逐字。 */
export function buildPostCompactMessages(summary: string, recent: ConvMessage[]): ConvMessage[] {
  const summaryMsg: UserMessage = createUserMessage(
    `<conversation_summary>\n${summary}\n</conversation_summary>\n\n` +
    'The conversation above was compacted to save context. Continue the work from this summary; ' +
    'the full original transcript is on disk if you need to verify a detail.',
  )
  return [summaryMsg, ...recent]
}

// 压缩进度事件（驱动 REPL 进度条）：chars = 已生成的摘要字符数。
export type CompactProgress = { type: 'compact_progress'; chars: number }

const PROGRESS_EMIT_EVERY = 500 // 每累积 ~500 字符 emit 一次，避免刷屏

// ── 摘要生成：一次 streamMessage 调用 + 流式瞬时重试。边生成边 yield 进度 ──────
async function* streamCompactSummary(
  messages: ConvMessage[],
  customInstructions: string | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<CompactProgress, string> {
  const eff = activeThresholds().effectiveWindow
  // 摘要专用输出上限：比正常输出小，避免一份摘要自己吃掉腾出的空间（设计文档 §7）。
  const summaryCap = Math.min(activeMaxTokens(), Math.max(4_000, Math.floor(eff * 0.15)))
  const toSummarize: ConvMessage[] = [
    ...messages,
    createUserMessage(buildCompactUserMessage(customInstructions)),
  ]

  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_STREAMING_RETRIES; attempt++) {
    try {
      let raw = ''
      let lastEmit = 0
      for await (const ev of streamMessage(toSummarize, {
        system: buildCompactSystemPrompt(),
        maxTokens: summaryCap,
        abortSignal: signal,
      })) {
        if (ev.type === 'text') {
          raw += ev.text
          if (raw.length - lastEmit >= PROGRESS_EMIT_EVERY) {
            lastEmit = raw.length
            yield { type: 'compact_progress', chars: raw.length }
          }
        }
      }
      yield { type: 'compact_progress', chars: raw.length }
      return raw
    } catch (err) {
      // 溢出错误不重试，直接上抛让 PTL 截头逻辑处理；中止也直接上抛。
      if (isOverflowError(err)) throw err
      if (err instanceof Error && err.name === 'AbortError') throw err
      lastErr = err // 瞬时错误：重试
    }
  }
  throw lastErr
}

// ── 编排 ─────────────────────────────────────────────────────────────────────
export interface CompactResult {
  compacted: boolean
  messages: ConvMessage[]
  summary?: string
  preTokens?: number
  willRetrigger?: boolean
  reason?: 'too_small'
}

export interface CompactOptions {
  trigger: 'auto' | 'manual'
  customInstructions?: string
  /** 系统 prompt + 工具定义的固定开销 token（用于落点预算与 willRetrigger 估算）。 */
  fixedOverheadTokens: number
  signal?: AbortSignal
}

/**
 * 压缩主入口。成功返回新消息 + willRetrigger；硬失败（PTL/流式重试耗尽）抛出，
 * 由调用方记一次熔断硬失败。对话过小则跳过（compacted:false, reason:'too_small'）。
 */
export async function* compactConversation(
  messages: ConvMessage[],
  opts: CompactOptions,
): AsyncGenerator<CompactProgress, CompactResult> {
  if (messages.length < MIN_MESSAGES_TO_COMPACT) {
    return { compacted: false, messages, reason: 'too_small' }
  }

  const preTokens = estimateTokens(messages)
  const th = activeThresholds()

  // PreCompact hook：把其 stdout 合并进摘要指令（与手动 /compact 的 customInstructions 同一个口子）。
  const preHookOut = await runPreCompactHook(opts.trigger, opts.customInstructions)
  const mergedInstructions =
    [opts.customInstructions, preHookOut]
      .filter((s): s is string => !!s && s.trim().length > 0)
      .join('\n\n') || undefined

  // 摘要请求自身可能 PTL → 截头重试 ≤3 次。
  let summaryInput: ConvMessage[] = messages
  let rawSummary: string | undefined
  for (let ptl = 0; ptl <= MAX_PTL_RETRIES; ptl++) {
    try {
      rawSummary = yield* streamCompactSummary(summaryInput, mergedInstructions, opts.signal)
      break
    } catch (err) {
      if (isOverflowError(err) && ptl < MAX_PTL_RETRIES) {
        summaryInput = truncateHeadForPTLRetry(summaryInput)
        continue
      }
      throw err // 非溢出错误，或 PTL 重试耗尽 → 硬失败上抛
    }
  }

  const summary = extractSummary(rawSummary ?? '')

  // 落点预算：压缩后总占用 ≈ effectiveWindow × 0.35 = 固定开销 + 摘要 + 最近。
  const summaryTokens = Math.ceil(summary.length / 4)
  const recentBudget = Math.max(
    0,
    landingTarget(th.effectiveWindow) - summaryTokens - opts.fixedOverheadTokens,
  )
  const recent = selectRecentMessages(messages, recentBudget)
  const newMessages = buildPostCompactMessages(summary, recent)

  // willRetrigger：压缩后估算（摘要 + 最近 + 固定开销）是否仍 ≥ autocompact 阈值。
  const postTokens = estimateTokens(newMessages) + opts.fixedOverheadTokens
  const willRetrigger = postTokens >= th.autocompact

  // PostCompact hook：纯副作用（通知 / 同步），非致命。
  await runPostCompactHook(opts.trigger, summary)

  return { compacted: true, messages: newMessages, summary, preTokens, willRetrigger }
}
