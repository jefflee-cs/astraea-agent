// Eclipse ctx-agent（querySource 概念上 = 'eclipse'）—— 后台折叠提议器。
//
// 用 querySmallModel（per-provider 小模型：haiku/gpt-4o-mini/deepseek-chat/本地）评估对话，
// 提议哪些【中段】span 值得折叠并给 risk 分。head（首个 user turn）与 tail（最近 ~15%×eff
// token）是保护区，永不折——保住原始意图锚点和活跃上下文，对抗任务漂移。
//
// 一次性非流式调用、不进 query() 递归，所以不会触发 autocompact/嵌套折叠。

import { querySmallModel } from '../../api/query-model'
import { estimateTokens } from '../compact/compact'
import { ECLIPSE_TAIL_RATIO, ECLIPSE_MAX_STAGE_RISK } from '../compact/window'
import type { ConvMessage, StagedCollapse } from './store'

const SYSTEM_PROMPT =
  'You compress an AI coding assistant conversation by proposing which MIDDLE spans to fold into one-line summaries. ' +
  'A span is foldable only if it is already RESOLVED / settled (a fixed bug, a concluded decision) and low future value. ' +
  'Never propose spans that contain unresolved constraints, the user\'s explicit requirements, or recent decisions. ' +
  'Reply with ONLY a JSON array, no prose.'

interface RawSpan { start: number; end: number; summary: string; risk: number }

/**
 * 评估 messages，返回应进 staged 队列的折叠候选（已按 risk≤上限 过滤）。
 * @param messages 当前主对话（compact boundary 之后）的内存数组
 * @param eff      当前 effectiveWindow（用于 tail token 预算）
 */
export async function proposeCollapses(
  messages: ConvMessage[],
  eff: number,
  signal?: AbortSignal,
): Promise<StagedCollapse[]> {
  const region = middleRegion(messages, eff)
  if (region.length < 2) return [] // 中段太短，无可折

  const prompt = buildPrompt(region.map(r => r.msg))
  let raw: string
  try {
    raw = await querySmallModel(prompt, signal, SYSTEM_PROMPT)
  } catch {
    return [] // 后台评估失败不影响主流程
  }

  const spans = parseSpans(raw)
  const now = Date.now()
  const out: StagedCollapse[] = []
  for (const s of spans) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) continue
    if (s.start < 0 || s.end >= region.length || s.start > s.end) continue
    if (typeof s.summary !== 'string' || !s.summary.trim()) continue
    const risk = clampRisk(s.risk)
    if (risk > ECLIPSE_MAX_STAGE_RISK) continue // 风险过高的敏感段不自动折
    // 映射回绝对索引，截取原始消息作为 archived（内容匹配身份）。
    const absStart = region[s.start]!.idx
    const absEnd = region[s.end]!.idx
    out.push({
      archived: messages.slice(absStart, absEnd + 1),
      summary: s.summary.trim(),
      risk,
      stagedAt: now,
    })
  }
  return out
}

// ── head/tail 保护：算出可折的中段（带绝对索引）──────────────────────────────
interface RegionItem { msg: ConvMessage; idx: number }

export function middleRegion(messages: ConvMessage[], eff: number): RegionItem[] {
  if (messages.length <= 2) return []
  // HEAD：保护第一个 user turn（索引 0 起的首条 user 消息）。
  let headEnd = 0
  while (headEnd < messages.length && messages[headEnd]!.role !== 'user') headEnd++
  // headEnd 现在指向首条 user；保护到它为止（含）。中段从 headEnd+1 起。
  const start = headEnd + 1

  // TAIL：从末尾累计 token，保护最近 ~ECLIPSE_TAIL_RATIO×eff 的消息。
  const tailBudget = Math.floor(eff * ECLIPSE_TAIL_RATIO)
  let acc = 0
  let tailStart = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens([messages[i]!])
    if (acc > tailBudget) { tailStart = i + 1; break }
    tailStart = i
  }

  const out: RegionItem[] = []
  for (let i = start; i < tailStart; i++) out.push({ msg: messages[i]!, idx: i })
  return out
}

// ── prompt 构建 / 解析 ─────────────────────────────────────────────────────────
function buildPrompt(region: ConvMessage[]): string {
  const lines = region.map((m, i) => `[${i}] ${m.role}: ${preview(m)}`)
  return [
    'Conversation MIDDLE region (head and tail are already protected and not shown):',
    '',
    lines.join('\n'),
    '',
    'Propose foldable spans. Output a JSON array; each item:',
    '{"start": <int index>, "end": <int index>, "summary": "<one line>", "risk": <0..1>}',
    'risk = chance that folding this span loses important info (0 safe, 1 dangerous).',
    'Only include genuinely settled spans. If nothing is safely foldable, output [].',
  ].join('\n')
}

function preview(m: ConvMessage): string {
  const c = m.content
  let text: string
  if (typeof c === 'string') text = c
  else
    text = c
      .map(b =>
        b.type === 'text' ? b.text
        : b.type === 'tool_use' ? `[tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 120)}]`
        : b.type === 'tool_result' ? `[tool_result ${typeof b.content === 'string' ? b.content.slice(0, 200) : '...'}]`
        : '')
      .join(' ')
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > 300 ? text.slice(0, 300) + '…' : text
}

export function parseSpans(raw: string): RawSpan[] {
  // 容错：模型可能包裹 ```json 或附带文字，截取第一个 [ 到最后一个 ]。
  const lo = raw.indexOf('[')
  const hi = raw.lastIndexOf(']')
  if (lo < 0 || hi <= lo) return []
  try {
    const parsed = JSON.parse(raw.slice(lo, hi + 1))
    if (!Array.isArray(parsed)) return []
    return parsed as RawSpan[]
  } catch {
    return []
  }
}

function clampRisk(r: unknown): number {
  const n = typeof r === 'number' ? r : Number(r)
  if (!Number.isFinite(n)) return 1 // 没给/无效 → 当最危险，不折
  return Math.min(1, Math.max(0, n))
}
