// Eclipse（上下文折叠）状态 store —— 进程级单例（设计文档：Context Collapse §3/§9）。
//
// 折叠是一种【投影】：原文一直留在 conversationRef / transcript，从不删。store 只记
// 「如何把中段换成摘要占位符」的施工图，projectView 在每次发请求前临时算出瘦身视图。
//
// 身份方案：astraea 内存消息没有 uuid，所以用【内容匹配】定位被折叠的 span——committed
// 折叠存下被折的原始消息数组 archived[]，projectView 在 messages 里找到与 archived 逐条
// 深相等的【连续子段】替换成占位符。无需给消息加 uuid，且 /resume 重建 messages 后仍能重匹配。
//
// 隔离：仅主对话(agentId==='default') 读写；子 agent 不碰。ctx-agent 走 querySmallModel
// 一次性调用、不进 query() 递归，结构上不可能触发 autocompact/嵌套折叠，故无需自保守卫。

import type { UserMessage, AssistantMessage } from '../../types/message'

export type ConvMessage = UserMessage | AssistantMessage

/** 暂存折叠（ctx-agent 提议、还没落地）。last-wins：每次 spawn 整体覆盖。 */
export interface StagedCollapse {
  archived: ConvMessage[]  // 候选被折的连续原始消息
  summary: string          // 摘要正文
  risk: number             // 折叠损失风险 0~1，越低越安全；commit 时低 risk 先折
  stagedAt: number
}

/** 已提交折叠（已落地）。append-only：按序重放重建视图。 */
export interface CommittedCollapse {
  id: string
  summary: string
  archived: ConvMessage[]
}

// ── 模块级单例状态 ─────────────────────────────────────────────────────────────
let committed: CommittedCollapse[] = []   // append-only，按提交顺序
let staged: StagedCollapse[] = []         // last-wins，整体替换
let armed = false                         // spawn 触发器是否已武装（到起步闸后置 true）
let lastSpawnTokens = 0                   // 上次 ctx-agent spawn 时的 token 数

// ── 读取 ───────────────────────────────────────────────────────────────────────
export function getCommitted(): CommittedCollapse[] { return committed }
export function getStaged(): StagedCollapse[] { return staged }
export function isArmed(): boolean { return armed }
export function getLastSpawnTokens(): number { return lastSpawnTokens }
export function hasCollapses(): boolean { return committed.length > 0 || staged.length > 0 }

// ── 写入 ───────────────────────────────────────────────────────────────────────
/** ctx-agent spawn 完成后整体替换暂存队列（last-wins）。 */
export function setStaged(next: StagedCollapse[]): void { staged = next }

export function setArmed(v: boolean): void { armed = v }
export function setLastSpawnTokens(n: number): void { lastSpawnTokens = n }

/** 把一条 staged 提升为 committed（append）。返回新建的 committed 项。 */
export function commitStaged(s: StagedCollapse): CommittedCollapse {
  const c: CommittedCollapse = { id: newCollapseId(), summary: s.summary, archived: s.archived }
  committed.push(c)
  staged = staged.filter(x => x !== s)
  return c
}

/** /clear /compact /login 时重置全部折叠状态（仅主线程调）。 */
export function resetEclipse(): void {
  committed = []
  staged = []
  armed = false
  lastSpawnTokens = 0
}

function newCollapseId(): string {
  // 16 位数字 ID（与设计文档 collapseId 风格一致），无需强随机。
  let s = ''
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 10)
  return s
}

// ── 投影（projectView）─────────────────────────────────────────────────────────
/**
 * 在 messages 副本上重放所有 committed 折叠，得到发给模型的瘦身视图。
 * 按提交顺序应用（后者可能覆盖前者已折区域）；每个 committed 用内容匹配定位被折段。
 * 最后做角色归一，避免占位符插入造成相邻同角色（部分 provider 要求 user/assistant 交替）。
 */
export function projectView(messages: ConvMessage[]): ConvMessage[] {
  if (committed.length === 0) return messages
  let view = [...messages]
  for (const c of committed) {
    const at = findSubsequence(view, c.archived)
    if (at < 0) continue // 该段已不在（被更早的折叠吞掉，或对话已变）→ 跳过
    const placeholder = makePlaceholder(c)
    view = [...view.slice(0, at), placeholder, ...view.slice(at + c.archived.length)]
  }
  return normalizeRoles(view)
}

/** 折叠占位符：一条 user 文本消息，内容是 <eclipsed> 摘要。 */
function makePlaceholder(c: CommittedCollapse): ConvMessage {
  return { role: 'user', content: `<eclipsed id="${c.id}">${c.summary}</eclipsed>` }
}

/** 在 haystack 里找与 needle 逐条深相等的连续子段起点；找不到返回 -1。 */
function findSubsequence(haystack: ConvMessage[], needle: ConvMessage[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      if (!msgEqual(haystack[i + j]!, needle[j]!)) { ok = false; break }
    }
    if (ok) return i
  }
  return -1
}

function msgEqual(a: ConvMessage, b: ConvMessage): boolean {
  if (a.role !== b.role) return false
  return JSON.stringify(a.content) === JSON.stringify(b.content)
}

/** 合并相邻同角色消息（占位符替换后可能产生 user,user）；保证 user/assistant 交替。 */
function normalizeRoles(msgs: ConvMessage[]): ConvMessage[] {
  const out: ConvMessage[] = []
  for (const m of msgs) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      out[out.length - 1] = mergeSameRole(last, m)
    } else {
      out.push(m)
    }
  }
  return out
}

function mergeSameRole(a: ConvMessage, b: ConvMessage): ConvMessage {
  const blocksA = toBlocks(a)
  const blocksB = toBlocks(b)
  return { role: a.role, content: [...blocksA, ...blocksB] } as ConvMessage
}

function toBlocks(m: ConvMessage): any[] {
  if (typeof m.content === 'string') return [{ type: 'text', text: m.content }]
  return m.content as any[]
}
