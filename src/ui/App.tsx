// 交互式 REPL UI — 使用 React Ink 渲染到终端
// 参考: claude-code-main/src/screens/REPL.tsx + components/App.tsx

import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { Box, Text, Static, useApp, useInput, usePaste } from 'ink'
import TextInput from './TextInput'
import { query } from '../query'
import { listTools, getInteractiveTools, findTool } from '../tools/registry'
import { findCommand } from '../commands/registry'
import { initMcp, getMcpStatus } from '../mcp/registry'
import { initPlugins } from '../plugins/init'
import { createUserMessage } from '../types/message'
import type { UserMessage, AssistantMessage } from '../types/message'
import { WelcomePanel } from './WelcomePanel'
import { StreamStatus } from './ThinkingIndicator'
import { LoginWizard, formatLoginSuccess } from './LoginWizard'
import type { LoginResult } from './LoginWizard'
import { config, updateProviderConfig, saveConfigToEnv } from '../config'
import { resetAllApiClients } from '../api/stream'
import { getSystemPrompt } from '../context/systemPrompt/builder'
import { onQuestion, answer } from '../tools/AskUserQuestionTool/bridge'
import type { PendingQuestion } from '../tools/AskUserQuestionTool/bridge'
import { setSessionSystemPrompt } from '../services/session-context'
import { startUDSServer } from '../services/uds-server'
import { getState, clearAllTasks } from '../services/agent-state'
import type { AgentTaskState } from '../services/agent-state'
import { clearTodos, getAllNamespaces } from '../services/todo-state'
import { renderMarkdown } from '../utils/markdown'
import { getMode, setMode } from '../state/sessionMode'
import type { SessionMode } from '../state/sessionMode'
import { compactConversation, estimateTokens } from '../services/compact/compact'
import { activeThresholds, percentLeft } from '../services/compact/window'
import {
  createTranscript,
  reopenTranscript,
  listSessions,
  loadSessionMessages,
  getLastAssistantTimestamp,
  type TranscriptWriter,
  type SessionSummary,
} from '../services/transcript/transcript'
import { scheduleHousekeeping } from '../services/transcript/housekeeping'
import { resetEclipse } from '../services/eclipse/store'
import { setLastAssistantTs, resetMicrocompactState } from '../state/microcompactState'
import { ResumePicker } from './ResumePicker'
import {
  resetContextTokens,
  markTokensUnknown,
  recordInputTokens,
  recordCompactionResult,
  recordCompactionFailure,
  getInputTokens,
} from '../state/contextTokens'
import {
  setGoal,
  clearGoal,
  getActiveGoal,
  getLastAchieved,
  GOAL_CLEAR_ALIASES,
  GOAL_MAX_CONDITION_LENGTH,
} from '../state/goalState'
import { ModeSelector, MODE_OPTIONS } from './ModeSelector'
import { ConfirmSelector, CONFIRM_CHOICES } from './ConfirmSelector'
import { onConfirmRequest, resolveConfirm, type ConfirmRequest } from '../tools/BashTool/permissions/confirmBridge'
import { VigilPanel, VIGIL_ACTIONS } from './VigilPanel'
import { SlashHint, allSlashCommands, matchSlashCommands } from './SlashHint'
import { ModeSwitchBanner, ModeInputFrame } from './ModeBanner'
import { ToolBatch, type ToolCall } from './ToolBatch'
import { TodoPanel } from './TodoPanel'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSettings, validateWechatSettings, resolveWechatSettings, resetSettingsCache } from '../settings'
import { abortWechatRead, WechatReadTool } from '../tools/WechatReadTool'

const VIGIL_RESULT_DIR = join(homedir(), '.astraea', 'task-results')

const INDIGO = '#6A5ACD'
const DEEP = '#1A0F40'   // dark navy-purple —— 用户消息底色（与 AstraeaSprite 同款品牌色）
const VERSION = '0.1.0'

function formatToolArg(name: string, input: Record<string, unknown>): string {
  const MAX = 120
  let arg: string
  switch (name) {
    case 'Read':
    case 'Write':
      arg = String(input['file_path'] ?? JSON.stringify(input))
      break
    case 'Bash':
    case 'PowerShell':
      arg = String(input['command'] ?? JSON.stringify(input))
      break
    default: {
      const raw = JSON.stringify(input)
      arg = raw.length > MAX ? raw.slice(0, MAX) + '…' : raw
    }
  }
  return arg.length > MAX ? arg.slice(0, MAX) + '…' : arg
}

// 把毫秒格式化为 "1h2m3s" / "2m3s" / "3s"
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return [h ? `${h}h` : '', m || h ? `${m}m` : '', `${sec}s`].filter(Boolean).join('')
}

// /goal 无参数时的状态文本：优先显示激活目标，否则显示上一条已达成记录。
function formatGoalStatus(): string {
  const active = getActiveGoal()
  if (active) {
    return [
      '◎ **/goal active**',
      '',
      `**Condition:** ${active.condition}`,
      `**Running for:** ${formatDuration(Date.now() - active.startedAt)}`,
      `**Turns evaluated:** ${active.turnsEvaluated}`,
      `**Token spend:** ${active.tokenSpend.toLocaleString()}`,
      active.lastReason ? `**Last check:** ${active.lastReason}` : '**Last check:** (pending first evaluation)',
    ].join('\n')
  }
  const achieved = getLastAchieved()
  if (achieved) {
    return [
      '◎ **/goal** — no active goal. Most recent achieved goal:',
      '',
      `**Condition:** ${achieved.condition}`,
      `**Duration:** ${formatDuration(achieved.durationMs)}`,
      `**Turns:** ${achieved.turns}`,
      `**Token spend:** ${achieved.tokenSpend.toLocaleString()}`,
      `**Why met:** ${achieved.reason}`,
    ].join('\n')
  }
  return '◎ **/goal** — no goal active. Set one with `/goal <condition>`.'
}

// ─────────────────────────── 类型 ────────────────────────────────────────────

interface HistoryEntry {
  id: string
  // 路径 A 重构（Stage 1）：tool_use/tool_result 两类合并为一条 'tools' 批（calls 承载，
  // 逐调用配对 + 同类折叠由 <ToolBatch> 渲染）。文本/banner 角色保持不变。
  role: 'welcome' | 'user' | 'assistant' | 'mode_banner' | 'skill_banner' | 'tools'
  text: string
  lines?: string[]       // 多行结果显示（历史遗留字段，'tools' 不用）
  calls?: ToolCall[]     // 'tools' 行专用：一个已落盘的工具批
}

// 工具结果 → 展示行：优先工具自带 renderResult，否则截断预览。live 流与 /resume 复用同一逻辑。
function buildResultLines(
  name: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
): string[] {
  const tool = listTools().find(t => t.name === name)
  const rendered = tool?.renderResult?.(input, output, isError) ?? null
  if (rendered) {
    return isError ? [`[error] ${rendered[0]}`, ...rendered.slice(1)] : rendered
  }
  const status = isError ? 'error' : 'ok'
  const preview = output.slice(0, 300)
  return [`[${status}] ${preview}${output.length > 300 ? '…' : ''}`]
}

// /resume：把恢复的对话消息转成可滚动回看的 history 条目（仅展示 user/assistant 文本）。
function rebuildHistoryEntries(
  msgs: (UserMessage | AssistantMessage)[],
  nextId: () => string,
): HistoryEntry[] {
  const out: HistoryEntry[] = []
  // 先把所有 tool_result 按 id 建索引，供 assistant 的 tool_use 回填。
  const resultById = new Map<string, { output: string; isError: boolean }>()
  for (const m of msgs) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const output = typeof b.content === 'string'
            ? b.content
            : b.content.map(x => (x as { text: string }).text).join('')
          resultById.set(b.tool_use_id, { output, isError: !!b.is_error })
        }
      }
    }
  }
  for (const m of msgs) {
    if (m.role === 'user') {
      const raw = typeof m.content === 'string'
        ? m.content
        : m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
      if (raw.includes('<conversation_summary>')) {
        out.push({ id: nextId(), role: 'assistant', text: '─────────  ✦ (compacted summary)  ─────────' })
        continue
      }
      const clean = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (clean) out.push({ id: nextId(), role: 'user', text: clean })
    } else {
      // assistant：按 block 顺序逐条还原——text 落 assistant 行，连续 tool_use 攒成一条 tools 批。
      let calls: ToolCall[] = []
      const flushCalls = () => {
        if (calls.length) { out.push({ id: nextId(), role: 'tools', text: '', calls }); calls = [] }
      }
      for (const b of m.content) {
        if (b.type === 'text') {
          flushCalls()
          const t = b.text.trim()
          if (t) out.push({ id: nextId(), role: 'assistant', text: t })
        } else if (b.type === 'tool_use') {
          if (b.name === 'TodoWrite') continue
          const r = resultById.get(b.id)
          const lines = r
            ? buildResultLines(b.name, b.input, r.output, r.isError)
            : ['(no result)']
          calls.push({
            toolUseId: b.id,
            name: b.name,
            argText: formatToolArg(b.name, b.input),
            status: r?.isError ? 'error' : 'done',
            resultLines: lines,
          })
        }
      }
      flushCalls()
    }
  }
  return out
}

// ─────────────────────────── 主组件 ──────────────────────────────────────────

export function App() {
  const { exit } = useApp()

  // history[0] = welcome panel (never changes); rest = conversation entries
  const [history, setHistory] = useState<HistoryEntry[]>([
    { id: 'welcome', role: 'welcome', text: '' },
  ])
  const [streamingText, setStreamingText] = useState('')
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [liveOutput, setLiveOutput] = useState<string>('')
  // 在途工具批（路径 A 重构）：liveToolsRef 是 async 流循环里同步读写的真相源，
  // liveTools 仅用于触发 live frame 重渲染。批结束（文本恢复 / done / abort）时落盘成 'tools' 行。
  const liveToolsRef = useRef<ToolCall[]>([])
  const [liveTools, setLiveTools] = useState<ToolCall[]>([])
  // 常驻状态行（StreamStatus）的数据：本次流式起始时刻 + 实时输出 token 估算。
  // runOutCharsRef 累积本次运行的输出字符数；token ≈ chars/4。
  const [streamStart, setStreamStart] = useState<number | null>(null)
  const runOutCharsRef = useRef(0)
  const [liveTokens, setLiveTokens] = useState(0)
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isCompacting, setIsCompacting] = useState(false)  // 压缩进行中
  const [compactChars, setCompactChars] = useState(0)      // 已生成摘要字符数 → 驱动进度条
  // 粘贴折叠（像 Claude Code）：大段粘贴在输入框里只显示占位符 [Pasted text #N …]，
  // 真实内容存在 ref map 里，提交时展开喂给模型。
  const pasteStoreRef = useRef<Map<string, string>>(new Map())
  const pasteCounterRef = useRef(0)
  const [showLogin, setShowLogin] = useState(false)
  // AskUserQuestion: pending question from the model
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
  // System prompt loaded asynchronously on mount
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null)
  const [sessionMode, setSessionModeState] = useState<SessionMode>('default')
  const [pendingModeSelect, setPendingModeSelect] = useState(false)
  const [modeSelectorIndex, setModeSelectorIndex] = useState(0)
  const [pendingVigilPanel, setPendingVigilPanel] = useState(false)
  const [vigilPanelIndex, setVigilPanelIndex] = useState(0)
  const [pendingResumePicker, setPendingResumePicker] = useState(false)
  const [resumePickerIndex, setResumePickerIndex] = useState(0)
  const resumeSessionsRef = useRef<SessionSummary[]>([])
  // Slash 命令选择器：高亮项索引。slashIndexRef 供 handleSubmit 同步读取（避免入 deps）。
  const [slashIndex, setSlashIndex] = useState(0)
  const slashIndexRef = useRef(0)
  // 权限确认方向键选择器（由 confirmBridge 驱动，工具执行中弹出）
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | null>(null)
  const [confirmIndex, setConfirmIndex] = useState(0)
  const [questionOptionIndex, setQuestionOptionIndex] = useState(-1)
  // "Chat about this" — when a question has options, the user can pick the extra
  // entry to instead type their own thoughts. true = free-text input is revealed.
  const [questionFreeText, setQuestionFreeText] = useState(false)
  const [vigilInlineValues, setVigilInlineValues] = useState<Record<string, string>>({})
  // 递增计数器，用于在目标状态变化 / 计时器 tick 时刷新 ◎ /goal active 横幅
  const [goalTick, setGoalTick] = useState(0)
  // 每次 /login 切换 provider/model 后自增，强制重算 modelId 并重建 system prompt
  const [configVersion, setConfigVersion] = useState(0)

  const conversationRef = useRef<(UserMessage | AssistantMessage)[]>([])
  // transcript 落盘（设计文档 §10）：writer + 已写盘的 conversationRef 条数（增量日志用）
  const transcriptRef = useRef<TranscriptWriter | null>(null)
  const loggedLenRef = useRef(0)
  const entryIdRef = useRef(0)
  // 写 liveToolsRef（同步真相）+ liveTools（触发重渲染）。
  const syncLiveTools = useCallback((next: ToolCall[]) => {
    liveToolsRef.current = next
    setLiveTools(next)
  }, [])
  // 把当前在途批落盘成一条 'tools' 行并清空。空批为 no-op。
  const commitLiveTools = useCallback(() => {
    if (liveToolsRef.current.length === 0) return
    const calls = liveToolsRef.current
    setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'tools', text: '', calls }])
    syncLiveTools([])
  }, [syncLiveTools])
  const commandHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const draftInputRef = useRef('')
  const abortControllerRef = useRef<AbortController | null>(null)
  // ESC double-press: 800ms 窗口内第二次 ESC 清空 input
  const lastEscPressRef = useRef(0)
  const escPendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [escClearHint, setEscClearHint] = useState(false)

  const modelId = useMemo(() => {
    const p = config.provider
    return p === 'ollama'
      ? config.ollama.model
      : p === 'openai'
        ? config.openai.model
        : p === 'deepseek'
          ? config.deepseek?.model ?? ''
          : config.anthropic.model
    // configVersion 在 /login 后变化，触发 modelId 重算（config 是模块级可变对象，
    // 非 React state，必须靠版本号手动让 memo 失效）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configVersion])

  // Load real system prompt on mount and rebuild whenever session mode changes
  // Also start UDS server for cross-process IPC (only on mount)
  useEffect(() => { startUDSServer() }, [])

  // MCP 启动期连接（实现文档 §1.7）：连上后工具进 getMcpTools()，下一轮 query 即可见。
  // 失败容忍（registry 记状态供 /mcp 面板展示）；不阻塞 UI。
  useEffect(() => {
    initPlugins()  // 先注册插件 skill/mcp 吸管，再连 MCP（含插件 server）
    void initMcp().then(() => {
      const failed = getMcpStatus().filter(s => s.state === 'failed')
      const ok = getMcpStatus().filter(s => s.state === 'connected')
      if (ok.length || failed.length) {
        setHistory(prev => [...prev, {
          id: String(entryIdRef.current++),
          role: 'assistant',
          text: `◎ MCP: ${ok.length} connected${ok.length ? ` (${ok.reduce((n, s) => n + s.toolCount, 0)} tools)` : ''}${failed.length ? `, ${failed.length} failed` : ''}.`,
        }])
      }
    })
  }, [])

  // transcript：挂载时开新会话（或 --resume 恢复）+ 调度 housekeeping（设计文档 §10）。
  useEffect(() => {
    if (transcriptRef.current) { scheduleHousekeeping(); return }
    const argv = process.argv.slice(2)
    const ri = argv.indexOf('--resume')
    if (ri !== -1) {
      const idArg = argv[ri + 1] && !argv[ri + 1]!.startsWith('-') ? argv[ri + 1] : undefined
      const sessions = listSessions(process.cwd())
      const target = idArg
        ? sessions.find(s => s.sessionId === idArg || s.sessionId.startsWith(idArg))
        : sessions[0]
      if (target) {
        const msgs = loadSessionMessages(target.path)
        conversationRef.current = msgs
        loggedLenRef.current = msgs.length
        transcriptRef.current = reopenTranscript(process.cwd(), target.sessionId)
        markTokensUnknown()
        // microcompact：从 transcript 回填最后一条 assistant 时间，让 resume 后首轮也能算 gap。
        { const ts = getLastAssistantTimestamp(target.path); if (ts !== null) setLastAssistantTs(ts) }
        setHistory([
          { id: 'welcome', role: 'welcome', text: '' },
          ...rebuildHistoryEntries(msgs, () => String(entryIdRef.current++)),
          { id: String(entryIdRef.current++), role: 'assistant', text: `◎ resumed ${msgs.length} messages (--resume). Continue where you left off.` },
        ])
        scheduleHousekeeping()
        return
      }
    }
    transcriptRef.current = createTranscript(process.cwd())
    scheduleHousekeeping()
  }, [])

  // 输入变化时把 slash 选择器高亮重置到第 0 项（导航只改 slashIndex，不会触发此处）。
  useEffect(() => { setSlashIndex(0); slashIndexRef.current = 0 }, [inputValue])

  // 流式开始的上升沿：重置常驻状态行的计时与 token 计数。覆盖所有流式入口
  // （主对话 / WechatRead / 其它次要查询循环），无需逐处埋点。
  useEffect(() => {
    if (isStreaming) {
      setStreamStart(Date.now())
      runOutCharsRef.current = 0
      setLiveTokens(0)
    }
  }, [isStreaming])

  useEffect(() => {
    return () => { if (escPendingTimerRef.current) clearTimeout(escPendingTimerRef.current) }
  }, [])

  // Poll for completed vigil task results and surface them in the REPL
  useEffect(() => {
    const poll = setInterval(() => {
      try {
        const files = readdirSync(VIGIL_RESULT_DIR)
        for (const file of files) {
          if (!file.endsWith('.json')) continue
          const path = join(VIGIL_RESULT_DIR, file)
          let content: { taskId: string; prompt: string; output: string; completedAt: string; read: boolean; failed?: boolean; filesWritten?: string[]; toolErrors?: string[] }
          try { content = JSON.parse(readFileSync(path, 'utf-8')) } catch { continue }
          if (content.read) continue
          // Mark read immediately to prevent double-display
          writeFileSync(path, JSON.stringify({ ...content, read: true }, null, 2))
          const shortPrompt = content.prompt.length > 80 ? content.prompt.slice(0, 80) + '…' : content.prompt
          const header = content.failed
            ? `**[Vigil task failed]** \`${content.taskId.slice(0, 8)}\``
            : `**[Vigil task complete]** \`${content.taskId.slice(0, 8)}\``
          const filesSection = content.filesWritten && content.filesWritten.length > 0
            ? `\n\n**Files written:**\n${content.filesWritten.map(f => `- \`${f}\``).join('\n')}`
            : ''
          const errorsSection = content.toolErrors && content.toolErrors.length > 0
            ? `\n\n**Tool errors:**\n${content.toolErrors.map(e => `- ${e}`).join('\n')}`
            : ''
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant' as const,
            text: `${header}\n\n> ${shortPrompt}\n\n${content.output}${filesSection}${errorsSection}`,
          }])
        }
      } catch { /* result dir not yet created */ }
    }, 2_000)
    return () => clearInterval(poll)
  }, [])

  useEffect(() => {
    // 交互对话不暴露微信工具（仅 /wechat、/vigil wechat 可触发），故系统提示里也不列出。
    const tools = getInteractiveTools()
    const enabledTools = new Set(tools.map(t => t.name))
    getSystemPrompt({ modelId, enabledTools, mode: sessionMode }).then(prompt => {
      setSystemPrompt(prompt)
      setSessionSystemPrompt(prompt)
    }).catch(() => {
      const fallback = 'You are Astraea, an AI coding assistant.'
      setSystemPrompt(fallback)
      setSessionSystemPrompt(fallback)
    })
  }, [modelId, sessionMode])

  // Poll running agents for spinner display.
  // ⚠️ 只在「运行中 agent 集合真正变化」时才 setState。否则每 500ms 都用一个全新数组
  // 调用 setRunningAgents，会强制整个 App 每秒重渲染两次；Ink 每次重渲染都要擦除并重绘
  // live frame，配合 <Static> 里多行 ANSI 内容会导致擦除越界、把刚落地的回复抹掉
  // （表现为「文字闪一下 0.1s 就消失」）。用签名比对消除空转重渲染。
  const [runningAgents, setRunningAgents] = useState<AgentTaskState[]>([])
  useEffect(() => {
    let lastSig = ''
    const interval = setInterval(() => {
      const agents = Object.values(getState().tasks).filter(
        (t): t is AgentTaskState => t.kind === 'agent' && t.status === 'running',
      )
      const sig = agents.map(a => `${a.id}:${a.status}`).join('|')
      if (sig !== lastSig) {
        lastSig = sig
        setRunningAgents(agents)
      }
    }, 500)
    return () => clearInterval(interval)
  }, [])

  // 目标激活时每秒 tick 一次，让 ◎ /goal active 横幅的计时实时刷新
  useEffect(() => {
    const interval = setInterval(() => {
      if (getActiveGoal()) setGoalTick(t => t + 1)
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  // Subscribe to AskUserQuestion bridge
  useEffect(() => {
    const unsubscribe = onQuestion(q => {
      setPendingQuestion(q)
      setInputValue('')
    })
    return unsubscribe
  }, [])

  // Subscribe to permission-confirm bridge → 渲染方向键确认选择器
  useEffect(() => {
    const unsubscribe = onConfirmRequest(req => {
      setPendingConfirm(req)
      setConfirmIndex(0)
    })
    return unsubscribe
  }, [])

  // Default cursor to first option whenever a new question arrives
  useEffect(() => {
    setQuestionOptionIndex(pendingQuestion?.options?.length ? 0 : -1)
    setQuestionFreeText(false)
  }, [pendingQuestion])

  // ── runConversation：统一的流式查询执行器 ──────────────────────────────────
  // 普通消息和 /goal 共用同一条流式管线。promptText 是喂给模型的内容，
  // displayText 是在 history 里展示为 "You: …" 的内容（默认与 promptText 相同）。
  // 恢复一个历史会话：重建 conversationRef + history、续写其 transcript、token 计数作废。
  const restoreSession = useCallback((target: SessionSummary) => {
    const msgs = loadSessionMessages(target.path)
    conversationRef.current = msgs
    loggedLenRef.current = msgs.length
    transcriptRef.current = reopenTranscript(process.cwd(), target.sessionId)
    markTokensUnknown()
    // microcompact：从 transcript 回填最后一条 assistant 时间，让 resume 后首轮也能算 gap。
    { const ts = getLastAssistantTimestamp(target.path); if (ts !== null) setLastAssistantTs(ts) }
    setHistory([
      { id: 'welcome', role: 'welcome', text: '' },
      ...rebuildHistoryEntries(msgs, () => String(entryIdRef.current++)),
      { id: String(entryIdRef.current++), role: 'assistant', text: `◎ resumed session — ${msgs.length} messages restored. Continue where you left off.` },
    ])
  }, [])

  const runConversation = useCallback(
    async (
      promptText: string,
      displayText?: string,
      // skill 斜杠入口（路径 A）的 per-query 线程化（实现文档 §1.6）：
      //   model     — skill frontmatter 的模型覆盖，仅作用于这一次 query
      //   extraTools — skill allowed-tools 的累加授权（把交互集之外的工具补进本次 query）
      //   skillName — 经斜杠入口命中的 skill 名，命中后在 user 行下补一行 "skill /<name> loaded." 提示
      runOpts?: { model?: string; extraTools?: import('../tools/Tool').Tool[]; skillName?: string },
    ) => {
      const controller = new AbortController()
      abortControllerRef.current = controller

      commandHistoryRef.current.push(displayText ?? promptText)
      historyIndexRef.current = -1
      setInputValue('')
      setIsStreaming(true)
      setStreamingText('')
      setActiveTool(null)
      setLiveOutput('')
      syncLiveTools([])

      setHistory(prev => [
        ...prev,
        { id: String(entryIdRef.current++), role: 'user', text: displayText ?? promptText },
        ...(runOpts?.skillName
          ? [{ id: String(entryIdRef.current++), role: 'skill_banner' as const, text: runOpts.skillName }]
          : []),
      ])

      const userMsg = createUserMessage(promptText)
      const messages = [...conversationRef.current, userMsg]

      let accumulated = ''
      // 整次运行是否产生过任何可见输出（文本/工具/裁决）。否则在 done 时补一行占位，
      // 避免「模型返回极简或空回复 → 界面一片空白看起来像卡死」。
      let anyVisibleOutput = false
      // 把当前累计的助手文本刷入 history（目标多轮运行时按 turn 分段展示）
      const flushAssistant = () => {
        if (accumulated.trim()) {
          setHistory(prev => [
            ...prev,
            { id: String(entryIdRef.current++), role: 'assistant', text: accumulated },
          ])
        }
        accumulated = ''
        setStreamingText('')
      }

      try {
        const queryTools = runOpts?.extraTools?.length
          ? [...getInteractiveTools(), ...runOpts.extraTools.filter(
              t => !getInteractiveTools().some(b => b.name === t.name))]
          : getInteractiveTools()
        for await (const event of query(messages, queryTools, {
          system: systemPrompt!,
          // 探索类任务（连续 Grep/Read）很容易跑十几二十轮。20 太低会把任务腰斩，
          // 表现为"运行到一半就结束"。抬到 100 作为防失控的硬上限，正常任务远够用；
          // 真撞到上限会经 max_turns_reached 提示用户继续，而非静默 return。
          maxTurns: 100,
          enablePromptCaching: true,
          abortSignal: controller.signal,
          autocompact: true,  // 仅主对话开启压缩 + token 计数（设计文档 §3/§6）
          model: runOpts?.model,  // skill frontmatter 模型覆盖（per-query）
        })) {
          switch (event.type) {
            case 'text':
              // 工具批结束、叙述恢复 → 先把在途批落盘，保证时序：…文本→工具批→文本…
              if (liveToolsRef.current.length > 0) commitLiveTools()
              accumulated += event.text
              // 常驻状态行的实时 token 估算（跨轮累积，token ≈ chars/4）。
              runOutCharsRef.current += event.text.length
              setLiveTokens(Math.ceil(runOutCharsRef.current / 4))
              if (event.text.trim()) anyVisibleOutput = true
              setStreamingText(accumulated)
              break

            case 'tool_use': {
              if (event.name === 'TodoWrite') break
              anyVisibleOutput = true
              // 叙述紧贴其工具调用：先把累积文本落盘，再把这次调用推进在途批。
              // live frame 由「文本」切到「工具行」，不会塌缩为 0 行 → 规避 done-bug 越界擦除。
              flushAssistant()
              setActiveTool(event.name)
              const argPreview = formatToolArg(event.name, event.input)
              syncLiveTools([
                ...liveToolsRef.current,
                { toolUseId: event.id, name: event.name, argText: argPreview, status: 'running' },
              ])
              break
            }

            case 'tool_progress': {
              setLiveOutput(prev => prev + event.chunk)
              break
            }

            case 'tool_result': {
              setLiveOutput('')
              setActiveTool(null)
              if (event.name === 'TodoWrite') break
              const lines = buildResultLines(event.name, event.input, event.output, event.isError)

              // 结果按 id 回填到在途批对应调用（逐调用配对的核心）。
              syncLiveTools(liveToolsRef.current.map(c =>
                c.toolUseId === event.id
                  ? { ...c, status: event.isError ? 'error' : 'done', resultLines: lines }
                  : c,
              ))

              const currentSingletonMode = getMode()
              setSessionModeState(prev => {
                if (prev !== currentSingletonMode) {
                  // 模式 banner 必须排在工具批之后 → 先把在途批落盘再插 banner。
                  commitLiveTools()
                  setHistory(h => [
                    ...h,
                    { id: String(entryIdRef.current++), role: 'mode_banner' as const, text: currentSingletonMode },
                  ])
                  return currentSingletonMode
                }
                return prev
              })
              break
            }

            // ── /goal Stop-hook 事件 ────────────────────────────────────────
            case 'goal_evaluated': {
              // 先把本轮助手文本落盘，再展示 evaluator 裁决
              flushAssistant()
              anyVisibleOutput = true
              const marker = event.met ? '✓ achieved' : '… continuing'
              setHistory(prev => [
                ...prev,
                {
                  id: String(entryIdRef.current++),
                  role: 'assistant',
                  text: `◎ **/goal** ${marker} · turn ${event.turns} — ${event.reason}`,
                },
              ])
              setGoalTick(t => t + 1)
              break
            }

            case 'goal_exhausted': {
              flushAssistant()
              setHistory(prev => [
                ...prev,
                {
                  id: String(entryIdRef.current++),
                  role: 'assistant',
                  text: `◎ **/goal** stopped — reached safety cap of ${event.maxTurns} turns. Last check: ${event.reason}`,
                },
              ])
              setGoalTick(t => t + 1)
              break
            }

            // ── 上下文压缩事件 ──────────────────────────────────────────────
            case 'compact_start': {
              flushAssistant()
              setActiveTool(null)
              setCompactChars(0)
              setIsCompacting(true)  // 转进度条，不落永久行
              break
            }

            case 'compact_progress': {
              setCompactChars(event.chars)
              break
            }

            case 'compact_done': {
              setIsCompacting(false)
              // transcript：写一条 compact 标记（含快照），并把已写盘长度重对齐到快照长度
              transcriptRef.current?.appendCompact(event.messages, event.summary, event.preTokens, event.trigger)
              loggedLenRef.current = event.messages.length
              setHistory(prev => [...prev, {
                id: String(entryIdRef.current++),
                role: 'assistant',
                text: `─────────  ✦ context compacted${event.willRetrigger ? ' (still large — may compact again)' : ''}  ─────────`,
              }])
              break
            }

            case 'compact_failed': {
              setIsCompacting(false)
              setHistory(prev => [...prev, {
                id: String(entryIdRef.current++),
                role: 'assistant',
                text: `⚠ compaction failed: ${event.reason}`,
              }])
              break
            }

            case 'compact_tripped': {
              setHistory(prev => [...prev, {
                id: String(entryIdRef.current++),
                role: 'assistant',
                text: '⚠ context can no longer be auto-compacted (circuit breaker). Trim manually with /compact, /clear, or start a new session.',
              }])
              break
            }

            case 'compact_blocked': {
              flushAssistant()
              setHistory(prev => [...prev, {
                id: String(entryIdRef.current++),
                role: 'assistant',
                text: `⚠ context full (~${Math.round(event.usedTokens / 1000)}K) and autocompact is off — run /compact to continue.`,
              }])
              break
            }

            case 'max_turns_reached': {
              // 撞到硬上限：之前会跟着 done 静默收尾，用户只看到任务半途而废、不知为何。
              // 这里显式落一行提示，并保留已产出的上下文——直接回车/补一句即可续跑。
              flushAssistant()
              setHistory(prev => [...prev, {
                id: String(entryIdRef.current++),
                role: 'assistant',
                text: `⚠ 已达单轮上限 ${event.maxTurns} 轮，任务可能未完成。直接回车或补一句"继续"即可接着跑。`,
              }])
              break
            }

            case 'done': {
              conversationRef.current = event.messages
              // transcript：增量写本轮新产生的消息（设计文档 §10 逐条 append）
              {
                const w = transcriptRef.current
                if (w?.enabled) {
                  const delta = event.messages.slice(loggedLenRef.current)
                  if (delta.length) w.appendMessages(delta)
                  loggedLenRef.current = event.messages.length
                }
              }
              // ESC 中止：UI 已在 ESC 处理器里更新（显示了 [cancelled]），这里只清理流式状态。
              // 已跑完的工具调用落盘保留，避免中止时丢掉用户已看到的结果。
              if (controller.signal.aborted) {
                accumulated = ''
                setStreamingText('')
                setIsStreaming(false)
                commitLiveTools()
                break
              }
              // ── 修复「回复闪一下就消失」──────────────────────────────────────
              // 根因：live streaming frame（多行）在 done 这一帧塌缩为 0，而 <Static>
              // 同一帧新增同样多行内容 → Ink 擦除 live frame 时行数算越界，把刚落地的
              // 回复一起抹掉。reasoning 模型（gpt-5.x）整段突发输出时尤其明显。
              // 解法：分两帧——先收起 live frame，再到下一帧才把回复 append 进 Static。
              const finalText = accumulated
              accumulated = ''
              setStreamingText('')      // 帧 A：live frame 干净收起（含在途工具批），Static 不变，无越界
              setIsStreaming(false)
              setGoalTick(t => t + 1)
              setTimeout(() => {        // 帧 B：live frame 已为 0，单纯向 Static 追加，安全
                // 先落盘以工具结尾的在途批（此时 finalText 为空），再落最终文本 → 顺序正确。
                commitLiveTools()
                if (finalText.trim()) {
                  setHistory(prev => [
                    ...prev,
                    { id: String(entryIdRef.current++), role: 'assistant', text: finalText },
                  ])
                } else if (!anyVisibleOutput) {
                  // 整次运行无任何可见输出（空回复且未调用工具）→ 补一行提示，避免界面像卡死
                  setHistory(prev => [
                    ...prev,
                    {
                      id: String(entryIdRef.current++),
                      role: 'assistant',
                      text: '_(model returned an empty reply — no text and no tool call. Try rephrasing, or switch model with /login.)_',
                    },
                  ])
                }
              }, 0)
              break
            }
          }
        }
      } catch (err) {
        // AbortError = ESC 中止，UI 已在 ESC 处理器里更新，这里静默清理（保留已跑完的工具批）
        if (err instanceof Error && err.name === 'AbortError') {
          setStreamingText('')
          setActiveTool(null)
          setLiveOutput('')
          commitLiveTools()
        } else {
          const errMsg = err instanceof Error ? err.message : String(err)
          commitLiveTools()   // 报错前已跑完的工具批落盘，便于定位失败上下文
          setHistory(prev => [
            ...prev,
            { id: String(entryIdRef.current++), role: 'assistant', text: `[Error: ${errMsg}]` },
          ])
          setStreamingText('')
          setIsStreaming(false)
          setActiveTool(null)
        }
      } finally {
        abortControllerRef.current = null
        setIsCompacting(false)  // 安全复位（覆盖压缩中途 abort 等边界）
      }
    },
    [systemPrompt],
  )

  const handleSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return

      // AskUserQuestion answer mode: relay to bridge, don't start a new query
      if (pendingQuestion) {
        setInputValue('')
        setPendingQuestion(null)
        // If the user navigated to an option with arrow keys, use that; otherwise use typed text
        const responseText =
          questionOptionIndex >= 0 && pendingQuestion.options?.[questionOptionIndex]
            ? pendingQuestion.options[questionOptionIndex]!
            : trimmed
        setQuestionOptionIndex(-1)
        setQuestionFreeText(false)
        const entryId = String(entryIdRef.current++)
        setHistory(prev => [...prev, { id: entryId, role: 'user', text: responseText }])
        answer(responseText)
        return
      }

      // ── 执行中也允许随时切换模式，立即对下一次工具调用生效 ─────────────────
      // （query.ts 每批工具前重读 getMode()）。input box 不锁定，不显示 "wait for astraea"。
      if (isStreaming) {
        const liveModeMatch = trimmed.match(/^\/mode\s+(default|orbit|cruise|forge|counsel)$/)
        if (liveModeMatch) {
          const newMode = liveModeMatch[1] as SessionMode
          setInputValue('')
          historyIndexRef.current = -1
          setMode(newMode)
          setSessionModeState(newMode)
          setHistory(prev => [
            ...prev,
            { id: String(entryIdRef.current++), role: 'mode_banner' as const, text: newMode },
          ])
        } else if (trimmed === '/mode') {
          setInputValue('')
          historyIndexRef.current = -1
          const currentIdx = MODE_OPTIONS.findIndex(o => o.value === getMode())
          setModeSelectorIndex(currentIdx >= 0 ? currentIdx : 0)
          setPendingModeSelect(true)
        }
        // 其它输入在执行中忽略（不开新会话），保留已输入文本供稍后提交
        return
      }
      if (!systemPrompt) return  // still loading

      // ── Slash 命令选择器：Enter 落在高亮命令上 ────────────────────────────────
      // 列表打开（/ 开头、无空格、有匹配）时，按高亮项的 enterAction 派发：
      //   complete → 补全 "/goal " 等待输参；execute/panel → 用全名重入正常路由。
      if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
        const matches = allSlashCommands().filter(c => c.name.startsWith(trimmed))
        if (matches.length > 0) {
          const cmd = matches[Math.min(slashIndexRef.current, matches.length - 1)]!
          if (cmd.enterAction === 'complete') {
            setInputValue(cmd.name + ' ')
            return
          }
          if (cmd.name !== trimmed) {
            // 用户在前缀上回车（如 /cl）→ 用解析出的全名重入，命中下方精确路由
            void handleSubmit(cmd.name)
            return
          }
          // cmd.name === trimmed 的 execute/panel：继续走下方既有精确路由
        }
      }

      if (trimmed === '/login') {
        setInputValue('')
        historyIndexRef.current = -1
        setShowLogin(true)
        return
      }

      // ── /model — 查看当前 provider / 模型 / 端点（零 token，纯本地读取 config）──
      if (trimmed === '/model') {
        setInputValue('')
        historyIndexRef.current = -1
        const p = config.provider
        const baseUrl =
          p === 'ollama' ? config.ollama.baseUrl
          : p === 'openai' ? config.openai.baseUrl
          : p === 'deepseek' ? config.deepseek.baseUrl
          : 'https://api.anthropic.com'
        const maxTokens =
          p === 'ollama' ? config.ollama.maxTokens
          : p === 'openai' ? config.openai.maxTokens
          : p === 'deepseek' ? config.deepseek.maxTokens
          : config.anthropic.maxTokens
        setHistory(prev => [...prev, {
          id: String(entryIdRef.current++),
          role: 'assistant',
          text: [
            '**Current model**',
            '',
            `  Provider     ${p}`,
            `  Model        ${modelId}`,
            `  Endpoint     ${baseUrl}`,
            `  Max tokens   ${maxTokens}`,
            '',
            '_Switch with /login._',
          ].join('\n'),
        }])
        return
      }

      // ── /clear — 把会话恢复到刚启动的干净状态，零 token ──────────────────────
      // 一次清空四层状态：① 模型侧对话历史 ② REPL 可见历史 ③ 实时流式缓冲
      // ④ 全局单例（goal / todos / 调度任务）。语义对齐 Claude Code 的 /clear：
      // 新会话从零开始，不向模型发送任何内容。
      if (trimmed === '/clear') {
        setInputValue('')
        historyIndexRef.current = -1

        // ① 模型侧对话历史 —— 下一次 query 不再携带任何上文
        conversationRef.current = []

        // ② 实时流式缓冲 —— 清掉可能残留的半截流式文本 / 工具指示 / 待答问题
        setStreamingText('')
        setActiveTool(null)
        setLiveOutput('')
        setPendingQuestion(null)

        // ③ 全局单例 —— goal、todos、所有在跑/已结束的调度任务
        clearGoal()                                   // 清除任何激活的目标
        resetContextTokens()                          // 清空上下文 token 计数 + 压缩熔断状态
        resetMicrocompactState()                      // 清空 microcompact 时间戳单例（新会话重新计时）
        resetEclipse()                                // 清空 Eclipse 折叠 store（跨会话不残留）
        transcriptRef.current = createTranscript(process.cwd())  // 新会话 → 新 transcript 文件
        loggedLenRef.current = 0
        for (const ns of getAllNamespaces()) clearTodos(ns)  // 清空所有命名空间的 todo
        const aborted = clearAllTasks()               // 协作式中止子 Agent 并丢弃任务字典
        setGoalTick(t => t + 1)

        // ④ REPL 可见历史 —— 只留 welcome 面板 + 一行创意清空回执
        const CLEAR_LINES = [
          '◌  slate wiped. the void welcomes you.',
          '◌  all threads cut. silence restored.',
          '◌  context: none. clarity: maximum.',
          '◌  memory dissolved. begin again.',
          '◌  the conversation never happened.',
          '◌  nothing remains. everything is possible.',
          '◌  tabula rasa.',
          '◌  a clean room awaits.',
          '◌  you are new here.',
          '◌  signal lost. static cleared.',
        ]
        const clearLine = CLEAR_LINES[Math.floor(Math.random() * CLEAR_LINES.length)]
        const fresh: HistoryEntry[] = [{ id: 'welcome', role: 'welcome', text: '' }]
        fresh.push({
          id: String(entryIdRef.current++),
          role: 'assistant',
          text: aborted > 0
            ? `◎ **/clear** — context cleared. Aborted ${aborted} running agent${aborted === 1 ? '' : 's'}.`
            : (clearLine ?? '◌  tabula rasa.'),
        })
        setHistory(fresh)
        return
      }

      // ── /compact — 手动压缩当前会话（设计文档 §9）────────────────────────────
      if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
        setInputValue('')
        historyIndexRef.current = -1
        const custom = trimmed.slice('/compact'.length).trim() || undefined
        if (conversationRef.current.length < 4) {
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant',
            text: '◌ /compact — conversation too small to compact.',
          }])
          return
        }
        const overhead = Math.ceil(
          ((systemPrompt ?? '').length +
            JSON.stringify(getInteractiveTools().map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))).length) / 4,
        )
        setCompactChars(0)
        setIsCompacting(true)
        try {
          // compactConversation 是 async generator：驱动它、把进度喂给进度条，done 时取返回值。
          const gen = compactConversation(conversationRef.current, {
            trigger: 'manual',
            customInstructions: custom,
            fixedOverheadTokens: overhead,
          })
          let r = await gen.next()
          while (!r.done) {
            if (r.value.type === 'compact_progress') setCompactChars(r.value.chars)
            r = await gen.next()
          }
          const res = r.value
          setIsCompacting(false)
          if (res.compacted) {
            conversationRef.current = res.messages
            resetEclipse() // 手动 /compact 后消息已重建，旧折叠施工图作废
            recordInputTokens(estimateTokens(res.messages) + overhead)
            recordCompactionResult(res.willRetrigger ?? false)
            transcriptRef.current?.appendCompact(res.messages, res.summary ?? '', res.preTokens ?? 0, 'manual')
            loggedLenRef.current = res.messages.length
            setHistory(prev => [...prev, {
              id: String(entryIdRef.current++),
              role: 'assistant',
              text: `─────────  ✦ context compacted${res.willRetrigger ? ' (still large)' : ''}  ─────────`,
            }])
          } else {
            setHistory(prev => [...prev, {
              id: String(entryIdRef.current++),
              role: 'assistant',
              text: '◌ /compact — nothing to compact.',
            }])
          }
        } catch (err: unknown) {
          setIsCompacting(false)
          recordCompactionFailure()
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant',
            text: `⚠ /compact failed: ${String(err)}`,
          }])
        }
        return
      }

      // ── /resume — 恢复历史会话（设计文档 §10）────────────────────────────────
      if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
        setInputValue('')
        historyIndexRef.current = -1
        const arg = trimmed.slice('/resume'.length).trim()
        const sessions = listSessions(process.cwd())
        if (sessions.length === 0) {
          setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: '◌ /resume — no past sessions in this directory.' }])
          return
        }
        if (!arg) {
          // 无参 → 打开键盘 picker（↑↓ 选 · Enter 恢复 · Esc 取消）
          resumeSessionsRef.current = sessions.slice(0, 30)
          setResumePickerIndex(0)
          setPendingResumePicker(true)
          return
        }
        const n = parseInt(arg, 10)
        const target = (Number.isFinite(n) && n >= 1 && n <= sessions.length)
          ? sessions[n - 1]
          : sessions.find(s => s.sessionId === arg || s.sessionId.startsWith(arg))
        if (!target) {
          setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: `⚠ /resume — session "${arg}" not found.` }])
          return
        }
        restoreSession(target)
        return
      }

      // ── /goal — 设定 / 查看 / 清除完成条件 ───────────────────────────────────
      if (trimmed === '/goal' || trimmed.startsWith('/goal ')) {
        setInputValue('')
        historyIndexRef.current = -1
        const arg = trimmed.slice('/goal'.length).trim()

        // /goal （无参数）→ 显示状态
        if (!arg) {
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant',
            text: formatGoalStatus(),
          }])
          return
        }

        // /goal clear|stop|off|reset|none|cancel → 清除激活目标
        if ((GOAL_CLEAR_ALIASES as readonly string[]).includes(arg.toLowerCase())) {
          const cleared = clearGoal()
          setGoalTick(t => t + 1)
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant',
            text: cleared
              ? `◎ **/goal** cleared.\n\n> ${cleared.condition}`
              : '◎ **/goal** — no active goal to clear.',
          }])
          return
        }

        // /goal <condition> → 设定目标并立即以 condition 为指令开跑
        if (arg.length > GOAL_MAX_CONDITION_LENGTH) {
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant',
            text: `◎ **/goal** condition too long (${arg.length} > ${GOAL_MAX_CONDITION_LENGTH} chars).`,
          }])
          return
        }
        setGoal(arg)
        setGoalTick(t => t + 1)
        setHistory(prev => [...prev, {
          id: String(entryIdRef.current++),
          role: 'assistant',
          text: `◎ **/goal** set — working until this holds:\n\n> ${arg}`,
        }])
        // condition 本身就是 directive —— 直接开跑，无需另发 prompt
        await runConversation(arg, `/goal ${arg}`)
        return
      }

      if (trimmed === '/help') {
        setInputValue('')
        historyIndexRef.current = -1
        setHistory(prev => [...prev, {
          id: String(entryIdRef.current++),
          role: 'assistant',
          text: [
            '**Available commands:**',
            '',
            '  /mode    — select session mode: orbit · cruise · forge · counsel · default',
            '  /goal    — set a completion condition Astraea works toward autonomously',
            '  /vigil   — manage scheduled background tasks: add · list · delete',
            '  /login   — configure API key and provider',
            '  /model   — show the current provider, model, and endpoint',
            '  /clear   — clear conversation history (also clears any active goal)',
            '  /help    — show this message',
          ].join('\n'),
        }])
        return
      }

      // /mode <name> — 直接切换到指定模式，零 token 消耗
      const modeArgMatch = trimmed.match(/^\/mode\s+(default|orbit|cruise|forge|counsel)$/)
      if (modeArgMatch) {
        const newMode = modeArgMatch[1] as SessionMode
        setInputValue('')
        historyIndexRef.current = -1
        setMode(newMode)
        setSessionModeState(newMode)
        setHistory(prev => [
          ...prev,
          { id: String(entryIdRef.current++), role: 'mode_banner' as const, text: newMode },
        ])
        return
      }

      // /mode — 展示方向键导航选择器，不走 AI，零 token 消耗
      if (trimmed === '/mode') {
        setInputValue('')
        historyIndexRef.current = -1
        // 预设光标停在当前模式
        const currentIdx = MODE_OPTIONS.findIndex(o => o.value === getMode())
        setModeSelectorIndex(currentIdx >= 0 ? currentIdx : 0)
        setPendingModeSelect(true)
        return
      }

      // pendingModeSelect 激活时，文本输入被 useInput 接管，此分支不应触发
      if (pendingModeSelect) return

      // /vigil — 弹出方向键导航面板
      if (trimmed === '/vigil') {
        setInputValue('')
        historyIndexRef.current = -1
        setVigilPanelIndex(0)
        setPendingVigilPanel(true)
        return
      }

      // /wechat — 立即执行微信聊天整理
      if (trimmed === '/wechat') {
        setInputValue('')
        historyIndexRef.current = -1
        resetSettingsCache()                 // 读取最新 settings.json，避免会话内缓存陈旧
        const wechatRaw = getSettings().wechat
        const validErr = validateWechatSettings(wechatRaw)
        if (validErr) {
          setHistory(prev => [...prev,
            { id: String(entryIdRef.current++), role: 'user', text: '/wechat' },
            { id: String(entryIdRef.current++), role: 'assistant', text: `⚠️ 微信整理配置不完整：\n\n${validErr}` },
          ])
          return
        }
        const wechatSettings = resolveWechatSettings(wechatRaw!)
        // Ensure outputDir exists
        if (!existsSync(wechatSettings.outputDir)) {
          mkdirSync(wechatSettings.outputDir, { recursive: true })
        }
        const today = new Date().toISOString().slice(0, 10)
        const outFile = join(wechatSettings.outputDir, `wechat-summary-${today}.md`)
        const scopeDesc = wechatSettings.scope.type === 'contacts'
          ? `指定联系人：${(wechatSettings.scope as { names: string[] }).names.join('、')}`
          : wechatSettings.scope.type === 'top'
            ? `最近 ${(wechatSettings.scope as { k: number }).k} 个联系人`
            : `所有联系人（上限 ${(wechatSettings.scope as { limit: number }).limit}）`

        setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'user', text: '/wechat' }])
        commandHistoryRef.current.push('/wechat')
        setIsStreaming(true); setStreamingText(''); setActiveTool('WechatRead'); setLiveOutput('')

        ;(async () => {
          let acc = ''
          const controller = new AbortController()
          const sigintHandler = () => { controller.abort(); abortWechatRead() }
          process.once('SIGINT', sigintHandler)
          try {
            // ── 1. 确定性收集：直接调用工具，scope/days/contacts/organize 全部来自
            //       settings.json，不交给 LLM 决策（杜绝漏联系人 / 错天数 / 错分类）。
            const collected = await WechatReadTool.call(
              { use_settings: true, wechat_settings: wechatSettings },
              { mode: 'default', abortSignal: controller.signal },
            )
            setActiveTool(null)

            if (collected.isError) {
              setHistory(prev => [...prev,
                { id: String(entryIdRef.current++), role: 'assistant', text: `⚠️ 微信读取失败：\n\n${collected.output}` },
              ])
              setStreamingText(''); setIsStreaming(false)
              return
            }

            // Per-contact coverage — use the actual contact names from settings,
            // NOT regex-parsed ## headers which would also match prompt sections
            // like "背景说明", "原始聊天记录", "整理任务".
            const contactNames: string[] =
              wechatSettings.scope.type === 'contacts'
                ? (wechatSettings.scope as { names: string[] }).names
                : (() => {
                    const m = collected.output.match(/涉及联系人：(.+)/)
                    return m ? m[1]!.split('、').map((s: string) => s.trim()).filter(Boolean) : []
                  })()

            const coverage = contactNames.map(name => {
              const idx = collected.output.indexOf(`## ${name}`)
              if (idx === -1) return { name, ok: false }
              const body = collected.output.slice(idx).split(/\n## /)[0] ?? ''
              const ok = !body.includes('（未找到消息）') && !/\nError:/.test(body) && !body.includes('No text found')
              return { name, ok }
            })

            // ── 2. LLM 只生成摘要正文（不调用任何工具，杜绝"假装写入"）──
            const aiPrompt = [
              `以下是已收集完毕的微信聊天记录与整理指令（范围：${scopeDesc}；最近 ${wechatSettings.days} 天；整理方式：${wechatSettings.organize.join('、')}）。`,
              `请严格按指令生成摘要。**只输出最终 Markdown 正文本身：不要任何前后说明、不要代码围栏。** 联系人名字保持原始中文，不得翻译。`,
              ``,
              collected.output,
            ].join('\n')

            const msgs = [...conversationRef.current, createUserMessage(aiPrompt)]
            for await (const ev of query(msgs, [], { system: systemPrompt!, maxTurns: 1, enablePromptCaching: true })) {
              if (ev.type === 'text') { acc += ev.text; setStreamingText(acc) }
              else if (ev.type === 'done') { conversationRef.current = ev.messages }
            }

            // ── 3. App 层确定性写入 + 校验 + 如实汇报 ──
            const summary = acc.trim()
            let report: string
            if (!summary) {
              report = `✗ 摘要生成为空，未写入文件。原始采集：\n${coverage.map(c => `${c.name}${c.ok ? ' ✓' : ' ✗未找到消息'}`).join('、')}`
            } else {
              try {
                writeFileSync(outFile, summary + '\n', 'utf-8')
                const missing = coverage.filter(c => !c.ok).map(c => c.name)
                report = [
                  `✓ 摘要已写入：${outFile}（${summary.length} 字）`,
                  `联系人覆盖：${coverage.map(c => `${c.name}${c.ok ? ' ✓' : ' ✗未找到消息'}`).join('、')}`,
                  ...(missing.length ? ['', `⚠️ ${missing.join('、')} 未读到内容——可能是 settings.json 里的名字与微信显示不完全一致，或导航/OCR 失败。`] : []),
                ].join('\n')
              } catch (e) {
                report = `✗ 写入失败：${outFile}\n${String(e)}`
              }
            }
            setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: report }])
            setStreamingText(''); setIsStreaming(false)
          } catch { setActiveTool(null); setIsStreaming(false) }
          finally { process.removeListener('SIGINT', sigintHandler) }
        })()
        return
      }

      // ── Skill 斜杠入口（路径 A，实现文档 §1.2/§1.6）──────────────────────────
      // /<name> [args] 命中 prompt 命令（= skill）且 user-invocable → 读全文注入对话，
      // 并把 skill 的 model / allowed-tools 经 per-query 线程化作用于本次 query。
      // 内置命令是 local/local-jsx，不会落到这里（上方已各自精确路由）。
      if (trimmed.startsWith('/')) {
        const m = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
        if (m) {
          const cmd = findCommand(m[1]!)
          // prompt 命令（= skill）：读全文注入 + per-query model/allowedTools 线程化
          if (cmd && cmd.type === 'prompt' && cmd.userInvocable) {
            const skillArgs = m[2]?.trim() || undefined
            const blocks = await cmd.getPrompt(skillArgs)
            const content = blocks.map(b => b.text).join('\n')
            const extraTools = (cmd.allowedTools ?? [])
              .map(name => findTool(name))
              .filter((t): t is import('../tools/Tool').Tool => !!t)
            await runConversation(content, trimmed, { model: cmd.model, extraTools, skillName: cmd.name })
            return
          }
          // local 命令（表内本地逻辑，如 /mcp）：跑 run() 显示文本，零 token。
          // 注：/model //help 等内置仍由上方既有 handler 抢先 return，不会落到这里。
          if (cmd && cmd.type === 'local' && cmd.userInvocable) {
            setInputValue('')
            historyIndexRef.current = -1
            const res = await cmd.run(m[2]?.trim() || undefined)
            if (res.type === 'text') {
              setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: res.value }])
            }
            return
          }
        }
      }

      // 展开粘贴占位符 → 真实内容喂给模型；history 仍显示占位符（trimmed）
      await runConversation(expandPastes(trimmed), trimmed)
    },
    [isStreaming, systemPrompt, pendingQuestion, pendingModeSelect, pendingVigilPanel, questionOptionIndex, runConversation],
  )

  const handleLoginDone = useCallback(async (result: LoginResult | null) => {
    setShowLogin(false)
    if (!result) return
    updateProviderConfig(result.provider, result.model, result.apiKey)
    resetAllApiClients()
    markTokensUnknown()  // 换模型 → 旧分词器的 token 数作废，等新 usage 刷新（设计文档 §6）
    resetEclipse()       // 换模型 → 折叠的 spawn token 计数按旧分词器，作废重来
    setConfigVersion(v => v + 1)  // 让 modelId 重算 → 触发 system prompt 按新模型重建
    await saveConfigToEnv()
    const successText = formatLoginSuccess(result)
    setHistory(prev => [
      ...prev,
      { id: String(entryIdRef.current++), role: 'assistant', text: successText },
    ])
  }, [])

  const handleVigilInlineAction = useCallback((actionKey: string, text: string) => {
    if (!text.trim() || !systemPrompt) return
    const trimmed = text.trim()
    setPendingVigilPanel(false)
    setVigilInlineValues({})

    let userText: string
    let aiPrompt: string

    if (actionKey === 'wechat') {
      // Validate settings before creating the vigil task
      const wechatRaw = getSettings().wechat
      const validErr = validateWechatSettings(wechatRaw)
      if (validErr) {
        setHistory(prev => [...prev,
          { id: String(entryIdRef.current++), role: 'user', text: `/vigil wechat ${trimmed}` },
          { id: String(entryIdRef.current++), role: 'assistant', text: `⚠️ 微信整理配置不完整：\n\n${validErr}` },
        ])
        return
      }
      const wechatSettings = resolveWechatSettings(wechatRaw!)
      userText = `/vigil wechat: ${trimmed}`
      aiPrompt = [
        `用户要创建一个定时微信聊天整理任务，执行时间为：${trimmed}`,
        ``,
        `任务配置（来自 settings.json）：`,
        `  范围：${JSON.stringify(wechatSettings.scope)}`,
        `  时间：最近 ${wechatSettings.days} 天`,
        `  整理方式：${wechatSettings.organize.join('、')}`,
        `  输出目录：${wechatSettings.outputDir}`,
        ``,
        `请使用 VigilOnce 或 VigilSchedule 注册任务，任务 prompt 为：`,
        `"整理微信聊天记录。调用 WechatRead 工具，传入参数 { use_settings: true, wechat_settings: ${JSON.stringify(wechatSettings)} }，`,
        `按返回的指令生成摘要，将结果写入 ${wechatSettings.outputDir}/ 目录下以日期命名的 .md 文件。"`,
        ``,
        `重要：`,
        `- 任务 prompt 中联系人名字必须保持原始中文`,
        `- 如果无法从 "${trimmed}" 中识别出明确的执行时间，请创建失败并说明原因`,
      ].join('\n')
    } else {
      userText = actionKey === 'add' ? trimmed : `/vigil delete ${trimmed}`
      aiPrompt = actionKey === 'add'
        ? `Schedule the following as a background task using VigilOnce (one-time) or VigilSchedule (recurring) — choose based on the user's intent: ${trimmed}`
        : `Delete the scheduled vigil task with ID: ${trimmed}. Use VigilDelete.`
    }

    setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'user', text: userText }])
    commandHistoryRef.current.push(userText)
    setIsStreaming(true); setStreamingText(''); setActiveTool(null); setLiveOutput('')

    const msgs = [...conversationRef.current, createUserMessage(aiPrompt)]
    ;(async () => {
      let acc = ''
      try {
        for await (const ev of query(msgs, getInteractiveTools(), { system: systemPrompt, maxTurns: 10, enablePromptCaching: true })) {
          if (ev.type === 'text') { acc += ev.text; setStreamingText(acc) }
          else if (ev.type === 'done') {
            conversationRef.current = ev.messages
            setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: acc }])
            setStreamingText(''); setIsStreaming(false)
          }
        }
      } catch { setIsStreaming(false) }
    })()
  }, [systemPrompt])

  // ── 粘贴折叠：大段粘贴 → 占位符；小段 → 直接插入 ──────────────────────────
  // ink v7 的 usePaste 在 bracketed-paste 模式下把整段粘贴作为单个字符串送来，
  // 且不会转发给 TextInput（useInput），因此输入框不会被刷屏。
  usePaste(
    (text) => {
      if (!text) return
      const lineCount = text.split('\n').length
      const isLarge = lineCount > 1 || text.length > 200
      if (!isLarge) {
        // 小段单行粘贴：直接插入，行为符合直觉
        setInputValue((prev) => prev + text)
        return
      }
      const id = ++pasteCounterRef.current
      const summary = lineCount > 1 ? `+${lineCount} lines` : `+${text.length} chars`
      const token = `[Pasted text #${id} ${summary}]`
      pasteStoreRef.current.set(token, text)
      historyIndexRef.current = -1
      setInputValue((prev) => prev + token)
    },
    { isActive: !pendingModeSelect && !pendingVigilPanel && !pendingConfirm && !pendingResumePicker && !(pendingQuestion?.options?.length && !questionFreeText) },
  )

  // 提交时把占位符展开回真实内容（喂给模型）；消费后从 store 删除。
  const expandPastes = useCallback((text: string): string => {
    let out = text
    for (const [token, content] of pasteStoreRef.current) {
      if (out.includes(token)) {
        out = out.split(token).join(content)
        pasteStoreRef.current.delete(token)
      }
    }
    return out
  }, [])

  useInput((_, key) => {
    if (showLogin) return

    // ── 权限确认选择器键盘控制（最高优先，工具执行中也响应）──────────────────
    if (pendingConfirm) {
      if (key.escape) {
        setPendingConfirm(null)
        resolveConfirm({ proceed: false, remember: null }) // Esc = 取消
        return
      }
      if (key.upArrow) {
        setConfirmIndex(i => (i - 1 + CONFIRM_CHOICES.length) % CONFIRM_CHOICES.length)
        return
      }
      if (key.downArrow) {
        setConfirmIndex(i => (i + 1) % CONFIRM_CHOICES.length)
        return
      }
      if (key.return) {
        const choice = CONFIRM_CHOICES[confirmIndex]
        setPendingConfirm(null)
        resolveConfirm(choice ? choice.result : { proceed: false, remember: null })
        return
      }
      return // 吞掉其它按键，确认期间不打字
    }

    // ── ResumePicker 键盘控制 ─────────────────────────────────────────────────
    if (pendingResumePicker) {
      const list = resumeSessionsRef.current
      if (key.escape) { setPendingResumePicker(false); return }
      if (list.length === 0) { setPendingResumePicker(false); return }
      if (key.upArrow) { setResumePickerIndex(i => (i - 1 + list.length) % list.length); return }
      if (key.downArrow) { setResumePickerIndex(i => (i + 1) % list.length); return }
      if (key.return) {
        const target = list[resumePickerIndex]
        setPendingResumePicker(false)
        if (target) restoreSession(target)
        return
      }
      return // 吞掉其它按键
    }

    // ── VigilPanel 键盘控制 ───────────────────────────────────────────────────
    if (pendingVigilPanel) {
      if (key.escape) { setPendingVigilPanel(false); return }
      if (key.upArrow) { setVigilPanelIndex(i => (i - 1 + VIGIL_ACTIONS.length) % VIGIL_ACTIONS.length); return }
      if (key.downArrow) { setVigilPanelIndex(i => (i + 1) % VIGIL_ACTIONS.length); return }
      if (key.return) {
        const action = VIGIL_ACTIONS[vigilPanelIndex]
        if (!action) return
        if (action.key === 'list') {
          setPendingVigilPanel(false)
          setVigilInlineValues({})
          setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'user', text: '/vigil list' }])
          setIsStreaming(true); setStreamingText(''); setActiveTool(null); setLiveOutput('')
          const msgs = [...conversationRef.current, createUserMessage('List all scheduled vigil tasks using VigilList.')]
          ;(async () => {
            let acc = ''
            try {
              for await (const ev of query(msgs, getInteractiveTools(), { system: systemPrompt!, maxTurns: 3, enablePromptCaching: true })) {
                if (ev.type === 'text') { acc += ev.text; setStreamingText(acc) }
                else if (ev.type === 'done') {
                  conversationRef.current = ev.messages
                  setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: acc }])
                  setStreamingText(''); setIsStreaming(false)
                }
              }
            } catch { setIsStreaming(false) }
          })()
        }
        // add / delete: TextInput's onSubmit handles submission — do nothing here
        return
      }
      return
    }

    // ── ModeSelector 键盘控制 ─────────────────────────────────────────────────
    if (pendingModeSelect) {
      if (key.escape) {
        setPendingModeSelect(false)
        return
      }
      if (key.upArrow) {
        setModeSelectorIndex(i => (i - 1 + MODE_OPTIONS.length) % MODE_OPTIONS.length)
        return
      }
      if (key.downArrow) {
        setModeSelectorIndex(i => (i + 1) % MODE_OPTIONS.length)
        return
      }
      if (key.return) {
        const selected = MODE_OPTIONS[modeSelectorIndex]
        if (selected) {
          setPendingModeSelect(false)
          setMode(selected.value)
          setSessionModeState(selected.value)
          setHistory(prev => [
            ...prev,
            {
              id: String(entryIdRef.current++),
              role: 'mode_banner' as const,
              text: selected.value,
            },
          ])
        }
        return
      }
      return
    }

    // ── Slash 命令选择器：列表打开时 ↑/↓ 导航、Tab 补全 ───────────────────────
    // 列表「打开」⟺ 输入以 / 开头、无空格、有匹配，且非流式/非问答态。
    // Enter 不在此拦截：交给 TextInput.onSubmit → handleSubmit 按 enterAction 派发，
    // 避免 useInput 与 TextInput 同时响应回车导致双触发。
    const slashMatches = matchSlashCommands(inputValue)
    if (slashMatches.length > 0 && !isStreaming && !pendingQuestion) {
      const len = slashMatches.length
      if (key.upArrow) {
        setSlashIndex(i => { const n = (i - 1 + len) % len; slashIndexRef.current = n; return n })
        return
      }
      if (key.downArrow) {
        setSlashIndex(i => { const n = (i + 1) % len; slashIndexRef.current = n; return n })
        return
      }
      if (key.tab) {
        const cmd = slashMatches[Math.min(slashIndexRef.current, len - 1)]!
        setInputValue(cmd.name)  // 只补全高亮项，永不执行
        return
      }
    }

    if (key.escape) {
      // Priority 1: ESC while streaming → cancel the AI request
      if (isStreaming && !pendingQuestion) {
        abortControllerRef.current?.abort()
        setIsStreaming(false)
        setStreamingText('')
        setActiveTool(null)
        setLiveOutput('')
        commitLiveTools()  // 已跑完的工具批先落盘，排在 _[cancelled]_ 之前（顺序正确）
        setHistory(prev => [
          ...prev,
          { id: String(entryIdRef.current++), role: 'assistant', text: '_[cancelled]_' },
        ])
        return
      }

      // Priority 1.5: Esc from "chat about this" free-text → back to the option list
      if (pendingQuestion?.options?.length && questionFreeText) {
        setQuestionFreeText(false)
        setQuestionOptionIndex(0)
        setInputValue('')
        return
      }

      // Priority 2: Dismiss pending question
      if (pendingQuestion) {
        setPendingQuestion(null)
        setInputValue('')
        setQuestionFreeText(false)
        answer('')
        return
      }

      // Priority 3: Double-press to clear input (800ms window)
      const now = Date.now()
      const isDoublePress = (now - lastEscPressRef.current) <= 800 && escPendingTimerRef.current !== null

      if (escPendingTimerRef.current) {
        clearTimeout(escPendingTimerRef.current)
        escPendingTimerRef.current = null
      }

      if (isDoublePress && inputValue) {
        // Second ESC: clear input, save to command history
        setEscClearHint(false)
        lastEscPressRef.current = 0
        if (inputValue.trim()) commandHistoryRef.current.push(inputValue)
        setInputValue('')
        historyIndexRef.current = -1
      } else if (inputValue) {
        // First ESC with non-empty input: show "Esc again to clear" hint
        lastEscPressRef.current = now
        setEscClearHint(true)
        escPendingTimerRef.current = setTimeout(() => {
          setEscClearHint(false)
          escPendingTimerRef.current = null
        }, 800)
      } else {
        // Empty input: clear history navigation, dismiss any stale hint
        setEscClearHint(false)
        lastEscPressRef.current = 0
        historyIndexRef.current = -1
      }
      return
    }
    if (isStreaming && !pendingQuestion) return

    // AskUserQuestion option navigation and confirmation.
    // A synthetic "Chat about this…" entry sits one past the real options
    // (index === options.length); selecting it reveals the free-text input.
    if (pendingQuestion?.options?.length && !questionFreeText) {
      const chatIdx = pendingQuestion.options.length
      if (key.upArrow) { setQuestionOptionIndex(i => Math.max(0, i - 1)); return }
      if (key.downArrow) { setQuestionOptionIndex(i => Math.min(chatIdx, i + 1)); return }
      if (key.return && questionOptionIndex >= 0) {
        if (questionOptionIndex === chatIdx) {
          // Switch to free-text: reveal the input box, keep the question open.
          setQuestionFreeText(true)
          setQuestionOptionIndex(-1)
          return
        }
        const selected = pendingQuestion.options[questionOptionIndex]!
        setInputValue('')
        setQuestionOptionIndex(0)
        setPendingQuestion(null)
        setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'user', text: selected }])
        answer(selected)
        return
      }
    }

    if (key.upArrow) {
      const hist = commandHistoryRef.current
      if (hist.length === 0) return
      if (historyIndexRef.current === -1) draftInputRef.current = inputValue
      historyIndexRef.current =
        historyIndexRef.current === -1 ? hist.length - 1 : Math.max(0, historyIndexRef.current - 1)
      setInputValue(hist[historyIndexRef.current]!)
      return
    }
    if (key.downArrow) {
      if (historyIndexRef.current === -1) return
      const hist = commandHistoryRef.current
      if (historyIndexRef.current >= hist.length - 1) {
        historyIndexRef.current = -1
        setInputValue(draftInputRef.current)
      } else {
        historyIndexRef.current++
        setInputValue(hist[historyIndexRef.current]!)
      }
    }
  })

  const toolNames = getInteractiveTools().map(t => t.name)

  const modelName =
    config.provider === 'ollama'
      ? config.ollama.model
      : config.provider === 'openai'
        ? config.openai.model
        : config.provider === 'deepseek'
          ? config.deepseek?.model ?? ''
          : config.anthropic.model

  // 执行中输入框保持可用（不锁定）：用户可随时 /mode 切换。仅在模式/面板覆盖层时让出焦点。
  const inputFocused = !pendingModeSelect && !pendingVigilPanel && !pendingConfirm && !pendingResumePicker
  const inputPlaceholder = pendingQuestion
    ? 'Type your answer… (Esc to skip)'
    : isStreaming
      ? 'Astraea is working… /mode to switch · Esc to cancel'
      : systemPrompt === null
        ? 'Initializing...'
        : 'Message Astraea… (Ctrl+C to exit)'

  // ─────────────────────────── 渲染 ──────────────────────────────────────────

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {entry => {
          if (entry.role === 'welcome') {
            return (
              <WelcomePanel
                key={entry.id}
                version={VERSION}
                cwd={process.cwd()}
                model={modelName}
                tools={toolNames}
              />
            )
          }
          if (entry.role === 'mode_banner') {
            return (
              <ModeSwitchBanner key={entry.id} mode={entry.text as SessionMode} />
            )
          }
          if (entry.role === 'skill_banner') {
            return (
              <Box key={entry.id} marginBottom={1}>
                <Text color={INDIGO}>✦ skill </Text>
                <Text bold color={INDIGO}>/{entry.text}</Text>
                <Text color={INDIGO} dimColor> loaded.</Text>
              </Box>
            )
          }
          if (entry.role === 'tools') {
            // 已落盘的工具批：逐调用配对 + 同类折叠由 <ToolBatch> 统一渲染。
            return <ToolBatch key={entry.id} calls={entry.calls ?? []} />
          }
          if (entry.role === 'user') {
            // 用户消息（含斜杠命令）整块铺 DEEP 深蓝底 + 横向内边距 → 与 Astraea 回复明显区分。
            // 对齐 CC 的 userMessageBackground；底色 hug 内容（最宽行决定块宽）。
            return (
              <Box key={entry.id} flexDirection="column" marginBottom={1} backgroundColor={DEEP} paddingX={1}>
                <Text bold color="green">❯ You</Text>
                <Text>{entry.text}</Text>
              </Box>
            )
          }
          // 其余（assistant 及以 assistant 角色落盘的系统提示）走 markdown 渲染。
          return (
            <Box key={entry.id} flexDirection="column" marginBottom={1}>
              <Text bold color={INDIGO}>✦ Astraea</Text>
              <Text>{renderMarkdown(entry.text)}</Text>
            </Box>
          )
        }}
      </Static>

      {isStreaming && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={INDIGO}>✦ Astraea</Text>
          {streamingText && <Text>{renderMarkdown(streamingText)}</Text>}
          {/* 在途工具批：逐调用配对 + 同类折叠，liveOutput 挂在 running 调用下。 */}
          {liveTools.length > 0 && <ToolBatch calls={liveTools} liveOutput={liveOutput} />}
          {/* 次要查询循环（如 WechatRead）只设 activeTool、不入 liveTools → 退回单行 spinner。 */}
          {liveTools.length === 0 && activeTool && (
            <Box flexDirection="column">
              <Text color="yellow">⏺  {activeTool}…</Text>
              {liveOutput && (
                <Box flexDirection="column" marginLeft={4}>
                  {liveOutput.trimEnd().split('\n').slice(-20).map((line, i) => (
                    <Text key={i} color="gray" dimColor>⎿  {line}</Text>
                  ))}
                </Box>
              )}
            </Box>
          )}
          {/* 常驻状态行：流式期间一直显示（轮换短语 + 实时秒数 + token + esc 提示），
              解决"跑到一半停住、不知是否还在运行"的问题。置于 live frame 底部。 */}
          <StreamStatus startTime={streamStart} tokens={liveTokens} />
        </Box>
      )}

      {/* Background agent spinners — shown even when main agent is idle */}
      {runningAgents.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {runningAgents.map(agent => (
            <Box key={agent.id}>
              <Text color="cyan">⟳  [{agent.id}] {agent.description}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* ◎ /goal active 指示器 —— goalTick 驱动每秒刷新 */}
      {(() => {
        void goalTick
        const g = getActiveGoal()
        if (!g) return null
        return (
          <Box marginBottom={1}>
            <Text color={INDIGO}>
              ◎ /goal active · {formatDuration(Date.now() - g.startedAt)} · {g.turnsEvaluated} turns
            </Text>
          </Box>
        )
      })()}

      {/* ◌ 压缩进度条（设计文档 §9）—— 摘要流式生成驱动 */}
      {isCompacting && (() => {
        const CELLS = 24
        const TARGET = 60_000 // 典型摘要字符数（~15K tokens），到 99% 封顶等收尾
        const frac = Math.min(0.99, compactChars / TARGET)
        const filled = Math.round(frac * CELLS)
        const bar = '█'.repeat(filled) + '░'.repeat(CELLS - filled)
        const approxK = (compactChars / 4 / 1000).toFixed(1)
        return (
          <Box marginBottom={1}>
            <Text color={INDIGO}>◌ compacting  [{bar}]  ~{approxK}K tokens</Text>
          </Box>
        )
      })()}

      {/* ✦ 上下文用量指示器 —— 接近自动压缩时常驻提示（设计文档 §9）*/}
      {(() => {
        void goalTick // 借用每秒 tick 触发刷新
        const used = getInputTokens()
        if (used === null) return null
        const th = activeThresholds()
        if (used < th.warning) return null
        const pctOfEff = Math.min(100, Math.round((used / th.effectiveWindow) * 100))
        const left = percentLeft(used, th.autocompact)
        const atCompact = used >= th.autocompact
        return (
          <Box marginBottom={1}>
            <Text color={atCompact ? 'red' : 'yellow'}>
              {atCompact ? '⚠' : '◔'} context {pctOfEff}% · ~{left}% to autocompact
            </Text>
          </Box>
        )
      })()}

      {/* AskUserQuestion prompt */}
      {pendingQuestion && (
        <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor={INDIGO} paddingX={1}>
          <Text bold color={INDIGO}>Astraea asks:</Text>
          <Text>{pendingQuestion.question}</Text>
          {pendingQuestion.options && pendingQuestion.options.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {pendingQuestion.options.map((opt, i) => {
                const isSelected = !questionFreeText && i === questionOptionIndex
                return (
                  <Text key={i} color={isSelected ? 'white' : 'gray'} bold={isSelected}>
                    {isSelected ? ' ❯ ' : '   '}{opt}
                  </Text>
                )
              })}
              {/* "Chat about this" — extra entry that opens a free-text reply */}
              {(() => {
                const chatIdx = pendingQuestion.options.length
                const isSelected = !questionFreeText && questionOptionIndex === chatIdx
                const active = isSelected || questionFreeText
                return (
                  <Text color={isSelected ? 'white' : questionFreeText ? INDIGO : 'gray'} bold={active} dimColor={!active}>
                    {active ? ' ❯ ' : '   '}✎ Chat about this…
                  </Text>
                )
              })()}
              <Text color="gray" dimColor>
                {questionFreeText ? 'type your thoughts · Enter send · Esc back' : '↑↓ select · Enter confirm'}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {showLogin && <LoginWizard onDone={handleLoginDone} />}

      {/* ConfirmSelector — 权限确认方向键选择器，覆盖输入框 */}
      {pendingConfirm && (
        <ConfirmSelector
          command={pendingConfirm.command}
          description={pendingConfirm.description}
          selectedIndex={confirmIndex}
        />
      )}

      {/* ModeSelector — 方向键导航，覆盖输入框 */}
      {pendingModeSelect && (
        <ModeSelector
          currentMode={sessionMode}
          selectedIndex={modeSelectorIndex}
        />
      )}

      {/* ResumePicker — 历史会话恢复选择器（/resume） */}
      {pendingResumePicker && (
        <ResumePicker
          sessions={resumeSessionsRef.current}
          selectedIndex={resumePickerIndex}
        />
      )}

      {/* VigilPanel — 定时任务操作选择 */}
      {pendingVigilPanel && (
        <VigilPanel
          selectedIndex={vigilPanelIndex}
          inlineValues={vigilInlineValues}
          onInlineChange={(key, value) => setVigilInlineValues(prev => ({ ...prev, [key]: value }))}
          onInlineSubmit={handleVigilInlineAction}
        />
      )}

      <TodoPanel />

      {!showLogin && !pendingModeSelect && !pendingVigilPanel && !pendingConfirm && !pendingResumePicker && (
        <ModeInputFrame mode={sessionMode}>
          {/* When a question with options is pending, hide the text input entirely —
              user navigates with ↑↓ + Enter just like the /mode selector.
              Unless they picked "Chat about this" (questionFreeText) — then the
              text box is revealed so they can type their own reply. */}
          {pendingQuestion?.options?.length && !questionFreeText ? (
            <Box>
              <Text bold color="yellow">↑↓ select · Enter confirm · Esc cancel</Text>
            </Box>
          ) : (
            <>
              {escClearHint && (
                <Box>
                  <Text color="gray" dimColor>Esc again to clear</Text>
                </Box>
              )}
              <SlashHint input={inputValue} selectedIndex={slashIndex} />
              <Box>
                <Text bold color={inputFocused && !isStreaming ? INDIGO : pendingQuestion ? 'yellow' : 'gray'}>
                  {pendingQuestion ? '? ' : isStreaming ? '  ' : '✦ '}
                </Text>
                <TextInput
                  value={inputValue}
                  onChange={val => {
                    historyIndexRef.current = -1
                    setInputValue(val)
                  }}
                  onSubmit={handleSubmit}
                  focus={inputFocused}
                  placeholder={inputPlaceholder}
                />
              </Box>
            </>
          )}
        </ModeInputFrame>
      )}
    </Box>
  )
}
