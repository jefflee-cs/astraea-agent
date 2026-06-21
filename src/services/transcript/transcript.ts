// Transcript 持久化（设计文档 §10）。
//
// 全量、append-only 的会话磁盘日志，供 /resume 与反漂移回查。
// 路径：~/.astraea/projects/<转义cwd>/<sessionId>.jsonl（转义 = /→-，同记忆目录）。
// 内存仍整体替换 conversationRef；transcript 在旁路留全量。压缩只追加一条 compact 标记。

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { config } from '../../config'
import { getSettings } from '../../settings'
import type { UserMessage, AssistantMessage } from '../../types/message'

type ConvMessage = UserMessage | AssistantMessage

export const DEFAULT_CLEANUP_PERIOD_DAYS = 30

/** transcript 保留天数（设计文档 §10 三档）：>0 保留天数；0 关闭持久化；<0 永久保留。 */
export function cleanupPeriodDays(): number {
  const d = getSettings().cleanupPeriodDays
  return typeof d === 'number' && Number.isFinite(d) ? d : DEFAULT_CLEANUP_PERIOD_DAYS
}

/** 0 = 关闭持久化（不写 transcript）。 */
export function isPersistenceEnabled(): boolean {
  return cleanupPeriodDays() !== 0
}

/** cwd 转义：/→-，与记忆目录同方案（/Users/x/y → -Users-x-y）。 */
export function escapeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

export function projectsRoot(): string {
  return join(homedir(), '.astraea', 'projects')
}

export function projectDir(cwd: string): string {
  return join(projectsRoot(), escapeCwd(cwd))
}

export function sessionPath(cwd: string, sessionId: string): string {
  return join(projectDir(cwd), `${sessionId}.jsonl`)
}

// ── 行类型 ───────────────────────────────────────────────────────────────────
interface SessionHeaderLine {
  type: 'session'
  sessionId: string
  cwd: string
  provider: string
  model: string
  version: string
  startedAt: string
}
interface MessageLine {
  type: 'user' | 'assistant'
  uuid: string
  timestamp: string
  message: ConvMessage
}
interface CompactLine {
  type: 'compact'
  uuid: string
  timestamp: string
  trigger: 'auto' | 'manual'
  preTokens: number
  summary: string
  snapshot: ConvMessage[] // 压缩后 conversationRef 快照（[摘要 + 最近]），供 /resume 精确恢复
}
interface RewindLine {
  type: 'rewind'
  uuid: string
  timestamp: string
  toTurn: number  // 回滚到的回合号（仅展示/审计用）
  convLen: number // 回滚后 conversationRef 应有的长度——loadSessionMessages 据此截断
}
type TranscriptLine = SessionHeaderLine | MessageLine | CompactLine | RewindLine

// ── Writer ───────────────────────────────────────────────────────────────────
export interface TranscriptWriter {
  readonly enabled: boolean
  readonly sessionId: string
  readonly path: string
  appendMessages(msgs: ConvMessage[]): void
  appendCompact(snapshot: ConvMessage[], summary: string, preTokens: number, trigger: 'auto' | 'manual'): void
  appendRewind(toTurn: number, convLen: number): void
}

const NOOP_WRITER: TranscriptWriter = {
  enabled: false,
  sessionId: '',
  path: '',
  appendMessages() {},
  appendCompact() {},
  appendRewind() {},
}

function activeModel(): string {
  switch (config.provider) {
    case 'deepseek': return config.deepseek.model
    case 'kimi':     return config.kimi.model
    case 'ollama':   return config.ollama.model
    case 'openai':   return config.openai.model
    default:         return config.anthropic.model
  }
}

function writeLine(path: string, line: TranscriptLine): void {
  try {
    appendFileSync(path, JSON.stringify(line) + '\n')
  } catch {
    // 落盘失败不影响主流程（transcript 是旁路）
  }
}

/** 开一个新会话的 transcript writer；持久化关闭时返回 no-op。 */
export function createTranscript(cwd: string): TranscriptWriter {
  if (!isPersistenceEnabled()) return NOOP_WRITER

  const sessionId = randomUUID()
  const dir = projectDir(cwd)
  const path = sessionPath(cwd, sessionId)
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const header: SessionHeaderLine = {
      type: 'session',
      sessionId,
      cwd,
      provider: config.provider,
      model: activeModel(),
      version: process.env.npm_package_version ?? 'dev',
      startedAt: new Date().toISOString(),
    }
    writeLine(path, header)
  } catch {
    return NOOP_WRITER // 建目录/写头失败 → 退化为不持久化，不阻断
  }

  return createTranscriptAt(sessionId, path)
}

/** /resume 时续写已有会话文件（不写头）。文件不存在或持久化关闭 → no-op。 */
export function reopenTranscript(cwd: string, sessionId: string): TranscriptWriter {
  if (!isPersistenceEnabled()) return NOOP_WRITER
  const path = sessionPath(cwd, sessionId)
  if (!existsSync(path)) return NOOP_WRITER
  const base = createTranscriptAt(sessionId, path)
  return base
}

// 内部：给定 sessionId+path 造 writer（不写头），createTranscript/reopen 复用。
function createTranscriptAt(sessionId: string, path: string): TranscriptWriter {
  return {
    enabled: true,
    sessionId,
    path,
    appendMessages(msgs) {
      for (const m of msgs) {
        writeLine(path, { type: m.role, uuid: randomUUID(), timestamp: new Date().toISOString(), message: m })
      }
    },
    appendCompact(snapshot, summary, preTokens, trigger) {
      writeLine(path, { type: 'compact', uuid: randomUUID(), timestamp: new Date().toISOString(), trigger, preTokens, summary, snapshot })
    },
    appendRewind(toTurn, convLen) {
      writeLine(path, { type: 'rewind', uuid: randomUUID(), timestamp: new Date().toISOString(), toTurn, convLen })
    },
  }
}

// ── Reader（/resume）─────────────────────────────────────────────────────────
export interface SessionSummary {
  sessionId: string
  path: string
  mtimeMs: number
  startedAt: string
  firstUserText: string // 首条用户消息预览，给 picker 展示
}

function parseLines(path: string): TranscriptLine[] {
  const out: TranscriptLine[] = []
  let raw: string
  try { raw = readFileSync(path, 'utf-8') } catch { return out }
  for (const ln of raw.split('\n')) {
    const t = ln.trim()
    if (!t) continue
    try { out.push(JSON.parse(t) as TranscriptLine) } catch { /* 跳过坏行 */ }
  }
  return out
}

function firstUserPreview(lines: TranscriptLine[]): string {
  for (const l of lines) {
    if (l.type === 'user') {
      const c = l.message.content
      const text = typeof c === 'string' ? c : c.map(b => ('text' in b ? b.text : '')).join('')
      const clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (clean) return clean.slice(0, 80)
    }
  }
  return '(no user message)'
}

/** 列出当前 cwd 的历史会话，按最近修改排序（picker 用）。 */
export function listSessions(cwd: string): SessionSummary[] {
  const dir = projectDir(cwd)
  if (!existsSync(dir)) return []
  const out: SessionSummary[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    try {
      const lines = parseLines(path)
      const header = lines.find(l => l.type === 'session') as SessionHeaderLine | undefined
      out.push({
        sessionId: name.replace(/\.jsonl$/, ''),
        path,
        mtimeMs: statSync(path).mtimeMs,
        startedAt: header?.startedAt ?? '',
        firstUserText: firstUserPreview(lines),
      })
    } catch { /* 跳过坏文件 */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * 重放 transcript 还原 conversationRef（设计文档 §10 + /rewind）。
 * 按行顺序折叠，两类标记改写累加器，正确处理 compact 与 rewind 的任意交错：
 *   · compact —— 用 snapshot 整体替换累加器（[摘要 + 最近]）；
 *   · rewind  —— 把累加器截到标记记录的 convLen（会话内时间倒流）；
 *   · user/assistant —— 追加消息。
 */
export function loadSessionMessages(path: string): ConvMessage[] {
  let msgs: ConvMessage[] = []
  for (const l of parseLines(path)) {
    if (l.type === 'user' || l.type === 'assistant') {
      msgs.push((l as MessageLine).message)
    } else if (l.type === 'compact') {
      msgs = [...(l as CompactLine).snapshot]
    } else if (l.type === 'rewind') {
      msgs = msgs.slice(0, (l as RewindLine).convLen)
    }
  }
  return msgs
}

/**
 * 读 transcript 最后一条 assistant 行的 timestamp（毫秒）；无则 null。
 * 给 /resume 回填 microcompact 的时间戳单例用——否则恢复后第一轮 lastAssistantTs===null
 * 不会触发 time-based microcompact。
 */
export function getLastAssistantTimestamp(path: string): number | null {
  const lines = parseLines(path)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!
    if (l.type === 'assistant') {
      const ms = Date.parse((l as MessageLine).timestamp)
      return Number.isNaN(ms) ? null : ms
    }
  }
  return null
}

/** 恢复当前 cwd 最近一个会话；无则返回 null。 */
export function loadLatestSession(cwd: string): { sessionId: string; messages: ConvMessage[] } | null {
  const sessions = listSessions(cwd)
  if (sessions.length === 0) return null
  const latest = sessions[0]!
  return { sessionId: latest.sessionId, messages: loadSessionMessages(latest.path) }
}
