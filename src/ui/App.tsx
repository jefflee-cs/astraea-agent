// 交互式 REPL UI — 使用 React Ink 渲染到终端
// 参考: claude-code-main/src/screens/REPL.tsx + components/App.tsx

import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { Box, Text, Static, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { query } from '../query'
import { listTools } from '../tools/registry'
import { createUserMessage } from '../types/message'
import type { UserMessage, AssistantMessage } from '../types/message'
import { WelcomePanel } from './WelcomePanel'
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
import {
  setGoal,
  clearGoal,
  getActiveGoal,
  getLastAchieved,
  GOAL_CLEAR_ALIASES,
  GOAL_MAX_CONDITION_LENGTH,
} from '../state/goalState'
import { ModeSelector, MODE_OPTIONS } from './ModeSelector'
import { VigilPanel, VIGIL_ACTIONS } from './VigilPanel'
import { SlashHint, SLASH_COMMANDS } from './SlashHint'
import { ModeSwitchBanner, ModeInputFrame } from './ModeBanner'
import { TodoPanel } from './TodoPanel'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSettings, validateWechatSettings, resolveWechatSettings, resetSettingsCache } from '../settings'
import { abortWechatRead, WechatReadTool } from '../tools/WechatReadTool'

const VIGIL_RESULT_DIR = join(homedir(), '.astraea', 'task-results')

const INDIGO = '#6A5ACD'
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
  role: 'welcome' | 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'mode_banner'
  text: string
  lines?: string[]  // multi-line result display (tool_result only)
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
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
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
  const [questionOptionIndex, setQuestionOptionIndex] = useState(-1)
  const [vigilInlineValues, setVigilInlineValues] = useState<Record<string, string>>({})
  // 递增计数器，用于在目标状态变化 / 计时器 tick 时刷新 ◎ /goal active 横幅
  const [goalTick, setGoalTick] = useState(0)
  // 每次 /login 切换 provider/model 后自增，强制重算 modelId 并重建 system prompt
  const [configVersion, setConfigVersion] = useState(0)

  const conversationRef = useRef<(UserMessage | AssistantMessage)[]>([])
  const entryIdRef = useRef(0)
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
    const tools = listTools()
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

  // Default cursor to first option whenever a new question arrives
  useEffect(() => {
    setQuestionOptionIndex(pendingQuestion?.options?.length ? 0 : -1)
  }, [pendingQuestion])

  // ── runConversation：统一的流式查询执行器 ──────────────────────────────────
  // 普通消息和 /goal 共用同一条流式管线。promptText 是喂给模型的内容，
  // displayText 是在 history 里展示为 "You: …" 的内容（默认与 promptText 相同）。
  const runConversation = useCallback(
    async (promptText: string, displayText?: string) => {
      const controller = new AbortController()
      abortControllerRef.current = controller

      commandHistoryRef.current.push(displayText ?? promptText)
      historyIndexRef.current = -1
      setInputValue('')
      setIsStreaming(true)
      setStreamingText('')
      setActiveTool(null)
      setLiveOutput('')

      setHistory(prev => [
        ...prev,
        { id: String(entryIdRef.current++), role: 'user', text: displayText ?? promptText },
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
        for await (const event of query(messages, listTools(), {
          system: systemPrompt!,
          maxTurns: 20,
          enablePromptCaching: true,
          abortSignal: controller.signal,
        })) {
          switch (event.type) {
            case 'text':
              accumulated += event.text
              if (event.text.trim()) anyVisibleOutput = true
              setStreamingText(accumulated)
              break

            case 'tool_use': {
              if (event.name === 'TodoWrite') break
              anyVisibleOutput = true
              setActiveTool(event.name)
              const argPreview = formatToolArg(event.name, event.input)
              setHistory(prev => [
                ...prev,
                { id: String(entryIdRef.current++), role: 'tool_use', text: `${event.name}(${argPreview})` },
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
              const tool = listTools().find(t => t.name === event.name)
              const renderedLines = tool?.renderResult?.(event.input, event.output, event.isError) ?? null
              let lines: string[]
              if (renderedLines) {
                lines = event.isError ? [`[error] ${renderedLines[0]}`, ...renderedLines.slice(1)] : renderedLines
              } else {
                const status = event.isError ? 'error' : 'ok'
                const preview = event.output.slice(0, 300)
                lines = [`[${status}] ${preview}${event.output.length > 300 ? '…' : ''}`]
              }

              const currentSingletonMode = getMode()
              setSessionModeState(prev => {
                if (prev !== currentSingletonMode) {
                  setHistory(h => [
                    ...h,
                    { id: String(entryIdRef.current++), role: 'mode_banner' as const, text: currentSingletonMode },
                  ])
                  return currentSingletonMode
                }
                return prev
              })

              setHistory(prev => [
                ...prev,
                { id: String(entryIdRef.current++), role: 'tool_result', text: lines[0]!, lines },
              ])
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

            case 'done': {
              conversationRef.current = event.messages
              // ESC 中止：UI 已在 ESC 处理器里更新（显示了 [cancelled]），这里只清理流式状态
              if (controller.signal.aborted) {
                accumulated = ''
                setStreamingText('')
                setIsStreaming(false)
                break
              }
              // ── 修复「回复闪一下就消失」──────────────────────────────────────
              // 根因：live streaming frame（多行）在 done 这一帧塌缩为 0，而 <Static>
              // 同一帧新增同样多行内容 → Ink 擦除 live frame 时行数算越界，把刚落地的
              // 回复一起抹掉。reasoning 模型（gpt-5.x）整段突发输出时尤其明显。
              // 解法：分两帧——先收起 live frame，再到下一帧才把回复 append 进 Static。
              const finalText = accumulated
              accumulated = ''
              setStreamingText('')      // 帧 A：live frame 干净收起，Static 不变，无越界
              setIsStreaming(false)
              setGoalTick(t => t + 1)
              setTimeout(() => {        // 帧 B：live frame 已为 0，单纯向 Static 追加，安全
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
        // AbortError = ESC 中止，UI 已在 ESC 处理器里更新，这里静默清理
        if (err instanceof Error && err.name === 'AbortError') {
          setStreamingText('')
          setActiveTool(null)
          setLiveOutput('')
        } else {
          const errMsg = err instanceof Error ? err.message : String(err)
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

      await runConversation(trimmed)
    },
    [isStreaming, systemPrompt, pendingQuestion, pendingModeSelect, pendingVigilPanel, questionOptionIndex, runConversation],
  )

  const handleLoginDone = useCallback(async (result: LoginResult | null) => {
    setShowLogin(false)
    if (!result) return
    updateProviderConfig(result.provider, result.model, result.apiKey)
    resetAllApiClients()
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
        for await (const ev of query(msgs, listTools(), { system: systemPrompt, maxTurns: 10, enablePromptCaching: true })) {
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

  useInput((_, key) => {
    if (showLogin) return

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
              for await (const ev of query(msgs, listTools(), { system: systemPrompt!, maxTurns: 3, enablePromptCaching: true })) {
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

    // Tab — 接受 slash 命令补全
    if (key.tab && !isStreaming && !pendingQuestion) {
      const match = SLASH_COMMANDS.find(
        c => c.name.startsWith(inputValue) && c.name !== inputValue && inputValue.startsWith('/'),
      )
      if (match) {
        setInputValue(match.name)
      }
      return
    }

    if (key.escape) {
      // Priority 1: ESC while streaming → cancel the AI request
      if (isStreaming && !pendingQuestion) {
        abortControllerRef.current?.abort()
        setIsStreaming(false)
        setStreamingText('')
        setActiveTool(null)
        setLiveOutput('')
        setHistory(prev => [
          ...prev,
          { id: String(entryIdRef.current++), role: 'assistant', text: '_[cancelled]_' },
        ])
        return
      }

      // Priority 2: Dismiss pending question
      if (pendingQuestion) {
        setPendingQuestion(null)
        setInputValue('')
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

    // AskUserQuestion option navigation and confirmation
    if (pendingQuestion?.options?.length) {
      if (key.upArrow) { setQuestionOptionIndex(i => Math.max(0, i - 1)); return }
      if (key.downArrow) { setQuestionOptionIndex(i => Math.min(pendingQuestion.options!.length - 1, i + 1)); return }
      if (key.return && questionOptionIndex >= 0) {
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

  const toolNames = listTools().map(t => t.name)

  const modelName =
    config.provider === 'ollama'
      ? config.ollama.model
      : config.provider === 'openai'
        ? config.openai.model
        : config.provider === 'deepseek'
          ? config.deepseek?.model ?? ''
          : config.anthropic.model

  // 执行中输入框保持可用（不锁定）：用户可随时 /mode 切换。仅在模式/面板覆盖层时让出焦点。
  const inputFocused = !pendingModeSelect && !pendingVigilPanel
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
          if (entry.role === 'tool_use') {
            return (
              <Box key={entry.id}>
                <Text color="yellow">⏺  {entry.text}</Text>
              </Box>
            )
          }
          if (entry.role === 'tool_result') {
            const displayLines = entry.lines ?? [entry.text]
            return (
              <Box key={entry.id} flexDirection="column" marginLeft={4} marginBottom={1}>
                <Text color="gray" dimColor>⎿  {displayLines[0]}</Text>
                {displayLines.slice(1).map((line, i) => {
                  const isAdded = line.trimStart().startsWith('+')
                  const isRemoved = line.trimStart().startsWith('-')
                  const color = isAdded ? 'green' : isRemoved ? 'red' : 'gray'
                  return (
                    <Text key={i} color={color} dimColor={!isAdded && !isRemoved}>
                      {'   '}{line}
                    </Text>
                  )
                })}
              </Box>
            )
          }
          return (
            <Box key={entry.id} flexDirection="column" marginBottom={1}>
              <Text bold color={entry.role === 'user' ? 'green' : INDIGO}>
                {entry.role === 'user' ? 'You' : 'Astraea'}
              </Text>
              <Text>{entry.role === 'assistant' ? renderMarkdown(entry.text) : entry.text}</Text>
            </Box>
          )
        }}
      </Static>

      {isStreaming && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={INDIGO}>Astraea</Text>
          {streamingText ? (
            <Text>{renderMarkdown(streamingText)}</Text>
          ) : (
            <Text color="gray" dimColor>✦ Thinking...</Text>
          )}
          {activeTool && (
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

      {/* AskUserQuestion prompt */}
      {pendingQuestion && (
        <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor={INDIGO} paddingX={1}>
          <Text bold color={INDIGO}>Astraea asks:</Text>
          <Text>{pendingQuestion.question}</Text>
          {pendingQuestion.options && pendingQuestion.options.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {pendingQuestion.options.map((opt, i) => {
                const isSelected = i === questionOptionIndex
                return (
                  <Text key={i} color={isSelected ? 'white' : 'gray'} bold={isSelected}>
                    {isSelected ? ' ❯ ' : '   '}{opt}
                  </Text>
                )
              })}
              <Text color="gray" dimColor>↑↓ select · Enter confirm</Text>
            </Box>
          )}
        </Box>
      )}

      {showLogin && <LoginWizard onDone={handleLoginDone} />}

      {/* ModeSelector — 方向键导航，覆盖输入框 */}
      {pendingModeSelect && (
        <ModeSelector
          currentMode={sessionMode}
          selectedIndex={modeSelectorIndex}
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

      {!showLogin && !pendingModeSelect && !pendingVigilPanel && (
        <ModeInputFrame mode={sessionMode}>
          {/* When a question with options is pending, hide the text input entirely —
              user navigates with ↑↓ + Enter just like the /mode selector */}
          {pendingQuestion?.options?.length ? (
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
              <SlashHint input={inputValue} />
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
