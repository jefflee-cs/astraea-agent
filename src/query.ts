// ★ 核心 Query 循环 — Agent 的 think → act → observe → repeat
// 参考源码: claude-code-main/src/query.ts (queryLoop, 第 281-1732 行)
//
// 原版的复杂特性（compaction、fallback model、stop hooks、并发工具执行）
// 全部省略，只保留最核心的 while(true) Agent 循环

import { streamMessage } from './api/stream'
import type { StreamEvent } from './types/message'
import {
  type AssistantMessage,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
  type UserMessage,
} from './types/message'
import type { Tool, ToolSchema, ToolContext } from './tools/Tool'
import { findTool } from './tools/registry'
import { getMode } from './state/sessionMode'
import { ask } from './tools/AskUserQuestionTool/bridge'
import { yieldMissingToolResultBlocks } from './utils/messages'
import {
  getSystemContext,
  getUserContext,
  appendSystemContext,
  prependUserContext,
} from './context/session-preamble'

import {
  createBudgetTracker,
  recordTurnTokens,
  checkTokenBudget,
} from './utils/token-budget'

import { loadMemoryIndex, buildRelevantMemoriesReminder } from './memory/inject'
import { forceExtractMemories, maybeExtractMemories, noteExtractionTurn, clampExtractCursor } from './memory/extract'
import { drainNotifications, hasPendingNotifications } from './services/notification-queue'
import { hasRunningAgents } from './services/agent-state'
import {
  getActiveGoal,
  recordGoalEvaluation,
  markGoalAchieved,
  clearGoal,
  GOAL_MAX_TURNS,
} from './state/goalState'
import { evaluateGoal, serializeTranscript } from './services/goal-evaluator'

import { config, activeContextWindow } from './config'
import { getCommands } from './commands/registry'
import { buildSkillMenu } from './commands/menu'
import { activeThresholds } from './services/compact/window'
import { compactConversation, estimateTokens, isOverflowError } from './services/compact/compact'
import { microcompact } from './services/compact/microCompact'
import { recordAssistantTs } from './state/microcompactState'
import {
  getInputTokens,
  recordInputTokens,
  recordCompactionResult,
  recordCompactionFailure,
  isCompactionTripped,
} from './state/contextTokens'
import {
  eclipseActive,
  projectForSend,
  maybeSpawn,
  commitIfNeeded,
  blockingIfNeeded,
  drainOnOverflow,
  resetEclipse,
} from './services/eclipse/eclipse'

// ─────────────────────────── 事件类型 ───────────────────────────────────────

// QueryEvent 是 StreamEvent 的超集：增加了 turn_start、tool_result、budget_stop
export type QueryEvent =
  | StreamEvent
  | { type: 'turn_start'; turn: number }
  | { type: 'tool_progress'; id: string; name: string; chunk: string }
  | { type: 'tool_result'; id: string; name: string; input: Record<string, unknown>; output: string; isError: boolean }
  | { type: 'max_turns_reached'; maxTurns: number }
  | { type: 'budget_stop'; reason: 'budget_reached' | 'diminishing_returns'; totalTokens: number }
  // /goal Stop-hook：每个 turn 结束后 evaluator 的裁决
  | { type: 'goal_evaluated'; met: boolean; reason: string; condition: string; turns: number }
  // /goal 达到安全上限被强制停止
  | { type: 'goal_exhausted'; reason: string; condition: string; maxTurns: number }
  // ── 上下文压缩（autocompact）事件 ──
  | { type: 'compact_start'; trigger: 'auto' | 'manual'; preTokens: number }
  | { type: 'compact_progress'; chars: number }
  | { type: 'compact_done'; trigger: 'auto' | 'manual'; willRetrigger: boolean; messages: (UserMessage | AssistantMessage)[]; summary: string; preTokens: number }
  | { type: 'compact_failed'; reason: string }
  | { type: 'compact_tripped' }    // 熔断跳闸：停止自动压缩，提示用户手动处理
  | { type: 'compact_blocked'; usedTokens: number }  // autocompact 关闭 + 撞 0.98 硬阻塞
  | { type: 'done'; messages: (UserMessage | AssistantMessage)[] }

// ─────────────────────────── 参数类型 ───────────────────────────────────────

export interface QueryOptions {
  system?: string
  maxTurns?: number          // 默认 50，防无限循环（探索类任务 10 太低会腰斩）
  enablePromptCaching?: boolean
  cwd?: string               // 用于 session preamble 的工作目录（默认 process.cwd()）
  tokenBudget?: number | null  // 输出 token 预算上限（null = 无限制）
  agentId?: string             // 用于调试追踪哪个 agent 触发了停止
  abortSignal?: AbortSignal    // ESC 取消信号
  isInteractive?: boolean      // 是否有交互式用户在场（默认 true）。false → 工具遇 ask fail-closed deny
  // 仅主对话开启：发请求前 autocompact 检查 + token 计数 + 反应式溢出兜底（设计文档 §3/§6/§8）。
  // App 的辅助 query 调用（welcome/mode 等）不开启，避免污染主对话的 token 单例。
  autocompact?: boolean
  // 单次模型覆盖（skill frontmatter 的 model 经此 per-query 生效，实现文档 §1.6）。缺省用全局 config。
  model?: string
}

// ─────────────────────────── 主函数 ─────────────────────────────────────────

export async function* query(
  initialMessages: (UserMessage | AssistantMessage)[],
  tools: Tool[],
  options: QueryOptions = {},
): AsyncGenerator<QueryEvent> {
  const maxTurns = options.maxTurns ?? 50
  // 当 /goal 激活时，正常的 maxTurns 会过早截断目标循环。目标循环改用更高的
  // GOAL_MAX_TURNS 作为硬上限（condition 自带的 turn/time 子句由 evaluator 判定）。
  const turnCap = () => (getActiveGoal() ? Math.max(maxTurns, GOAL_MAX_TURNS) : maxTurns)
  const cwd = options.cwd ?? process.cwd()
  const budget = options.tokenBudget ?? null
  const agentId = options.agentId ?? 'default'

  // 每个 query() 调用创建独立的 tracker，防止跨调用（父/子 agent）间的 token 计数污染
  let tracker = createBudgetTracker(agentId)

  // 把 Tool[] 转成 API 需要的 ToolSchema[]
  const toolSchemas: ToolSchema[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))

  // ── Session Preamble ──────────────────────────────────────────────────────
  // Both calls are memoized at Promise level — safe to call concurrently and
  // multiple times; the underlying I/O runs exactly once per process lifetime.
  const [sysCtx, userCtx] = await Promise.all([
    getSystemContext(),
    getUserContext(cwd),
  ])

  let system = appendSystemContext(options.system ?? '', sysCtx)

  // ── 渐进式披露：skill 一级菜单（实现文档 §1.4）──────────────────────────────
  // 仅当本次 query 暴露了 Skill 工具时注入（子 agent 无 Skill 工具 → 不浪费 token）。
  // 菜单会话内稳定 → 进可缓存系统提示前缀。
  if (tools.some(t => t.name === 'Skill')) {
    const menu = buildSkillMenu(getCommands(cwd), activeContextWindow())
    if (menu) system = `${system}\n\n${menu}`
  }

  // <system-reminder>（CLAUDE.md + 日期）每轮为模型调用「新鲜注入」，但【不】持久进对话数组，
  // 否则会逐轮在头部累积、膨胀上下文。取出 reminder 块，对话数组保持干净。
  const reminderBlock = prependUserContext([], userCtx)[0]!
  // 定稿 #10：MEMORY.md 索引走 reminder 块（每 query 调用新鲜读，反映会内写入）。
  const memIndex = await loadMemoryIndex(cwd)
  if (memIndex && typeof reminderBlock.content === 'string') {
    reminderBlock.content += `\n\n<system-reminder>\n${memIndex}\n</system-reminder>`
  }
  const reminderChars = typeof reminderBlock.content === 'string' ? reminderBlock.content.length : 0

  // 压缩用：系统 prompt + 工具定义 + reminder 的固定开销（每轮都在、压缩腾不掉）。chars/4 估算。
  // 仅当调用方显式 opt-in（主对话）时启用压缩相关逻辑，避免辅助 query 污染 token 单例。
  const compactionEnabled = options.autocompact === true
  // 记忆提取（通道 B）只在主对话开（与 compaction 同一「主对话 opt-in」信号），
  // 避免辅助/子 query 触发后台提取。
  const memoryExtractionOn = compactionEnabled
  const fixedOverheadTokens = Math.ceil(
    (system.length + JSON.stringify(toolSchemas).length + reminderChars) / 4,
  )

  // State: 每轮追加 assistantMessage + toolResultMessage。
  // 对话数组保持干净（剥掉任何历史遗留的 reminder）；reminder 仅在 streamMessage 调用时前置。
  let messages: (UserMessage | AssistantMessage)[] = stripReminders([...initialMessages])
  let turnCount = 1

  // 定稿 #10/#12/#13：召回 ≤5 条相关记忆，拼到用户消息尾部（逐消息变，远离缓存前缀）。
  // 每 query 调用跑一次（= 每条用户消息）；optional，失败/零记忆返回 null 不阻塞。
  // recentTools 去噪：正用某工具时别召该工具用法、但召它的坑。
  const recallSignal = options.abortSignal ?? new AbortController().signal
  const recallResult = await buildRelevantMemoriesReminder(
    latestUserText(messages),
    cwd,
    recallSignal,
    recentToolNames(messages),
  )
  const relevantTail: UserMessage | null = recallResult
    ? { role: 'user', content: recallResult.reminder }
    : null

  // counsel 模式两段式闸（Permission & Safety Technical Spec §7）：
  //   ① counselConsulted    — 是否已通过 AskUserQuestion 向用户确认过方向
  //   ② counselStartConfirmed — 方向确认后，用户是否已回答"现在开始执行"
  // 两者皆 true 前，框架层拦截所有「非只读」工具（与 orbit 的硬闸对称）。
  // 随 query() 调用作用域存活 → 每个用户请求都需重新确认。
  let counselConsulted = false
  let counselStartConfirmed = false

  // 反应式溢出兜底：每个 query() 调用最多触发一次，防止重试死循环。
  let reactiveCompacted = false

  while (true) {
    yield { type: 'turn_start', turn: turnCount }

    // ── 0a. Microcompact（先轻后重：排在 autocompact 之前；仅主对话）──────────
    // time-based：离开 ≥ 阈值分钟后回来时，清空旧 tool 输出（保留骨架 + 最近 N 个）。
    // 纯机械、不调模型。清理后用本地估算覆写 token 单例，让下面的 autocompact 检查读到
    // 变小后的数——若已压回阈下，autocompact 本轮即 no-op，保住细粒度上下文。
    if (compactionEnabled) {
      const mc = microcompact(messages)
      if (mc.cleared) {
        messages = mc.messages
        clampExtractCursor(messages.length) // 压缩重建消息数组后夹住提取游标（连带前置 #3）
        recordInputTokens(estimateTokens(messages) + fixedOverheadTokens)
      }
    }

    // ── 0. Autocompact 检查（发请求前；仅主对话）────────────────────────────
    if (compactionEnabled) {
      const used = getInputTokens()
      if (used !== null) {
        const th = activeThresholds()
        if (config.autocompact) {
          // Eclipse 开启时压制【主动】autocompact（设计文档：折叠接管 0.85~0.95 带，防 autocompact
          // 抢跑把细粒度一刀切）。reactive（413 兜底）不查 eclipseActive，仍能接溢出。
          if (used >= th.autocompact && !isCompactionTripped() && !eclipseActive()) {
            yield { type: 'compact_start', trigger: 'auto', preTokens: used }
            try {
              const res = yield* compactConversation(messages, {
                trigger: 'auto',
                fixedOverheadTokens,
                signal: options.abortSignal,
              })
              if (res.compacted) {
                messages = res.messages
                clampExtractCursor(messages.length) // 压缩重建消息数组后夹住提取游标（连带前置 #3）
                recordInputTokens(estimateTokens(messages) + fixedOverheadTokens)
                recordCompactionResult(res.willRetrigger ?? false)
                yield { type: 'compact_done', trigger: 'auto', willRetrigger: res.willRetrigger ?? false, messages: res.messages, summary: res.summary ?? '', preTokens: res.preTokens ?? 0 }
                if (isCompactionTripped()) yield { type: 'compact_tripped' }
              }
            } catch (err: unknown) {
              if (err instanceof Error && err.name === 'AbortError') {
                yield { type: 'done', messages }
                return
              }
              recordCompactionFailure()
              yield { type: 'compact_failed', reason: String(err) }
              if (isCompactionTripped()) yield { type: 'compact_tripped' }
              // 压缩失败：继续发请求，可能溢出 → 反应式兜底
            }
          }
        } else if (used >= th.blocking) {
          // autocompact 关闭：撞 0.98 硬阻塞 → 拦住请求，要用户手动 /compact
          yield { type: 'compact_blocked', usedTokens: used }
          yield { type: 'done', messages }
          return
        }
      }
    }

    // ── 0b. Eclipse 折叠（发请求前；仅主对话，feature-gated，关闭时全 no-op）──────
    // commit：到 0.85 吃后台 staged 存货、低 risk 先折（非阻塞，无模型调用）。
    // blocking：到 0.95 存货不够 → 当场同步现折，主线程必须等完才放行。
    // 提交只改 Eclipse store；真正瘦身发生在下方 streamMessage 的 projectForSend()。
    if (compactionEnabled) {
      commitIfNeeded(messages, fixedOverheadTokens)
      await blockingIfNeeded(messages, fixedOverheadTokens, options.abortSignal)
    }

    // ── 1. 调用模型，收集流式事件 ──────────────────────────────────────────
    const contentBlocks: (TextBlock | ToolUseBlock)[] = []
    const toolUseBlocks: ToolUseBlock[] = []
    let turnOutputTokens = 0
    // 截断追踪：撞输出上限时模型停止原因 = 'max_tokens'；被截断在工具调用中途的 id 进 set
    let stopReason: import('./types/message').StopReason | undefined
    const incompleteToolIds = new Set<string>()

    // assistantMessage 在流结束前先设为 null，用于错误恢复
    let assistantMessage: AssistantMessage | null = null

    try {
      for await (const event of streamMessage([reminderBlock, ...projectForSend(messages), ...(relevantTail ? [relevantTail] : [])], {
        system,
        enablePromptCaching: options.enablePromptCaching,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        abortSignal: options.abortSignal,
        model: options.model,
      })) {
        // 透传给上层（CLI 渲染）
        yield event

        // 同时收集内容，用于构建 AssistantMessage
        if (event.type === 'text') {
          const last = contentBlocks.at(-1)
          if (last?.type === 'text') {
            // 合并相邻的 text block
            last.text += event.text
          } else {
            contentBlocks.push({ type: 'text', text: event.text })
          }
        } else if (event.type === 'tool_use') {
          const block: ToolUseBlock = {
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: event.input,
          }
          contentBlocks.push(block)
          toolUseBlocks.push(block)
          if (event.incomplete) incompleteToolIds.add(event.id)
        } else if (event.type === 'message_stop') {
          turnOutputTokens = event.usage.output_tokens
          stopReason = event.stopReason
          // 触发用聚合 input_tokens（仅主对话）：记最近一次响应的真值，供下轮阈值检查。
          if (compactionEnabled) {
            recordInputTokens(event.usage.input_tokens)
            // Microcompact time-based 触发用：记下这一刻为"最后一条 assistant 时间"。
            recordAssistantTs()
            // Eclipse 后台 spawn：token 增量+起步闸触发（fire-and-forget，不阻塞本轮）。
            maybeSpawn(messages, options.abortSignal)
          }
        }
      }
    } catch (err: unknown) {
      // ESC 中止：保存部分消息后干净退出，不抛给调用方
      if (err instanceof Error && err.name === 'AbortError') {
        const partial: AssistantMessage = { role: 'assistant', content: contentBlocks }
        yield { type: 'done', messages: contentBlocks.length > 0 ? [...messages, partial] : messages }
        return
      }
      // Eclipse 溢出急救（drain-then-reactive）：先排空 staged 折叠腾空间，静默重试本轮
      // （projectForSend 会应用新折叠，prompt 变瘦，保细粒度）。没存货可排则落到 reactive 全量压缩。
      if (compactionEnabled && isOverflowError(err) && eclipseActive()) {
        if (drainOnOverflow().length > 0) continue
      }
      // 反应式溢出兜底：请求因上下文超窗口被拒 → 强制压缩一次 → 重试本轮（设计文档 §8）。
      // 溢出在请求阶段发生，contentBlocks 此时为空，丢弃重试安全。每个 query() 调用至多一次。
      if (compactionEnabled && isOverflowError(err) && !reactiveCompacted && !isCompactionTripped()) {
        reactiveCompacted = true
        yield { type: 'compact_start', trigger: 'auto', preTokens: getInputTokens() ?? estimateTokens(messages) }
        try {
          const res = yield* compactConversation(messages, {
            trigger: 'auto',
            fixedOverheadTokens,
            signal: options.abortSignal,
          })
          if (res.compacted) {
            messages = res.messages
            clampExtractCursor(messages.length) // 压缩重建消息数组后夹住提取游标（连带前置 #3）
            resetEclipse() // 全量压缩后消息已重建，旧折叠施工图作废，清空 store
            recordInputTokens(estimateTokens(messages) + fixedOverheadTokens)
            recordCompactionResult(res.willRetrigger ?? false)
            yield { type: 'compact_done', trigger: 'auto', willRetrigger: res.willRetrigger ?? false, messages: res.messages, summary: res.summary ?? '', preTokens: res.preTokens ?? 0 }
          }
          continue // 重试本轮（turnCount 不变）
        } catch (e2: unknown) {
          if (e2 instanceof Error && e2.name === 'AbortError') {
            yield { type: 'done', messages }
            return
          }
          recordCompactionFailure()
          yield { type: 'compact_failed', reason: String(e2) }
          // 落到下面常规错误处理
        }
      }
      // API 调用出错：如果已经收到了带 tool_use 的 assistant 消息，
      // 需要补齐 tool_result，否则下次 API 调用会因不配对而报 400
      if (toolUseBlocks.length > 0) {
        const partialAssistant: AssistantMessage = { role: 'assistant', content: contentBlocks }
        const errorMsg = `API error during tool execution: ${String(err)}`
        const errorResults = [...yieldMissingToolResultBlocks(partialAssistant, errorMsg)]
        // 追加到历史，让调用方知道这轮中断了
        messages = [...messages, partialAssistant, ...errorResults]
      }
      throw err
    }

    // ── 2. 构建 AssistantMessage ───────────────────────────────────────────
    assistantMessage = {
      role: 'assistant',
      content: contentBlocks,
    }

    // ── 2a. 更新预算追踪器并检查是否达到停止条件 ──────────────────────────
    tracker = recordTurnTokens(tracker, turnOutputTokens)
    const budgetDecision = checkTokenBudget(tracker, budget)
    if (budgetDecision.action === 'stop') {
      yield {
        type: 'budget_stop',
        reason: budgetDecision.reason,
        totalTokens: tracker.lastGlobalTurnTokens,
      }
      yield { type: 'done' as const, messages: [...messages, assistantMessage] }
      return
    }

    // ── 3. 无工具调用 → 检查是否有后台 Agent 仍在运行 ─────────────────────
    if (toolUseBlocks.length === 0) {
      // 纯文本输出撞了 max_tokens 被截断 → 注入续写指令，让模型从断点接着写，
      // 而不是把半截内容当成最终答复交还用户。turnCap 仍是硬上限，不会无限续。
      if (stopReason === 'max_tokens' && turnCount < turnCap()) {
        const continueMsg: UserMessage = {
          role: 'user',
          content: [{ type: 'text', text: buildContinuationDirective() }],
        }
        messages = [...messages, assistantMessage, continueMsg]
        turnCount++
        continue
      }

      const immediateNotifs = drainNotifications()

      if (immediateNotifs.length > 0) {
        // Notifications arrived during this turn — feed them to the model
        const waitMsg: UserMessage = {
          role: 'user',
          content: immediateNotifs.map(n => ({ type: 'text' as const, text: n })),
        }
        messages = [...messages, assistantMessage, waitMsg]
        if (turnCount >= turnCap()) {
          yield { type: 'max_turns_reached', maxTurns: turnCap() }
          yield { type: 'done' as const, messages }
          return
        }
        turnCount++
        continue
      }

      if (hasRunningAgents()) {
        // Agents still running but no notifications yet — poll without calling model
        // This avoids burning tokens while idle-waiting
        while (hasRunningAgents() && !hasPendingNotifications() && !options.abortSignal?.aborted) {
          await Bun.sleep(200)
        }
        if (options.abortSignal?.aborted) {
          yield { type: 'done', messages: [...messages, assistantMessage] }
          return
        }
        // Re-enter the loop: notifications are now available (or agents finished)
        const freshNotifs = drainNotifications()
        if (freshNotifs.length > 0) {
          const waitMsg: UserMessage = {
            role: 'user',
            content: freshNotifs.map(n => ({ type: 'text' as const, text: n })),
          }
          messages = [...messages, assistantMessage, waitMsg]
          if (turnCount >= turnCap()) {
            yield { type: 'max_turns_reached', maxTurns: turnCap() }
            yield { type: 'done' as const, messages }
            return
          }
          turnCount++
          continue
        }
      }

      // ── /goal Stop-hook ──────────────────────────────────────────────────
      // 真正的停止点：无工具调用、无待处理通知、无运行中 agent。若有激活的目标，
      // 在交还控制权前先让 evaluator 裁决；未达成则注入"继续"指令并再跑一轮。
      const goal = getActiveGoal()
      if (goal) {
        const transcript = serializeTranscript([...messages, assistantMessage])
        let decision: { met: boolean; reason: string }
        try {
          decision = await evaluateGoal(goal.condition, transcript)
        } catch (err: unknown) {
          // evaluator 出错不应让目标崩溃：保守判未达成并继续
          decision = { met: false, reason: `evaluator error: ${String(err)} — continuing` }
        }
        recordGoalEvaluation(decision.reason, tracker.lastGlobalTurnTokens)
        const updated = getActiveGoal()
        const turnsSoFar = updated?.turnsEvaluated ?? goal.turnsEvaluated + 1

        yield {
          type: 'goal_evaluated',
          met: decision.met,
          reason: decision.reason,
          condition: goal.condition,
          turns: turnsSoFar,
        }

        if (decision.met) {
          // 达成 → 记录"已达成"并清除目标，正常交还控制权
          markGoalAchieved(decision.reason)
        } else if (turnsSoFar >= GOAL_MAX_TURNS) {
          // 安全上限 → 强制停止，清除目标，提示用户
          clearGoal()
          yield {
            type: 'goal_exhausted',
            reason: decision.reason,
            condition: goal.condition,
            maxTurns: GOAL_MAX_TURNS,
          }
        } else {
          // 未达成 → 注入继续指令，再跑一轮（不交还控制权）
          const directive: UserMessage = {
            role: 'user',
            content: [{ type: 'text', text: buildGoalDirective(goal.condition, decision.reason) }],
          }
          messages = [...messages, assistantMessage, directive]
          turnCount++
          continue
        }
      }

      // 通道 B 停止钩子（#26）：模型给出最终回复、无 tool call → 强制提取一次（尾随不节流）。
      // fire-and-forget，绝不阻塞交还控制权；失败/超时游标不动、下轮重试。
      if (memoryExtractionOn) {
        forceExtractMemories({ messages: [...messages, assistantMessage], system, cwd })
      }

      yield { type: 'done' as const, messages: [...messages, assistantMessage] }
      return
    }

    // ── 4. 执行所有工具调用（有 callStream 的工具顺序执行并 yield 进度，其余并行）────
    const toolResultBlocks: ToolResultBlock[] = []

    // 每轮工具执行前构建 ctx（mode 在执行过程中可能由 EnterOrbitMode/ExitOrbitMode 改变，
    // 因此在这里读取快照；单个工具调用内 mode 不变）
    const toolCtx: ToolContext = {
      mode: getMode(),
      agentId: options.agentId,
      abortSignal: options.abortSignal,
      isInteractive: options.isInteractive ?? true, // query() 是交互式 REPL 引擎，默认 true
    }

    // 分流式 vs 普通工具
    const streamingBlocks = toolUseBlocks.filter(b => !!findTool(b.name)?.callStream)
    const normalBlocks    = toolUseBlocks.filter(b => !findTool(b.name)?.callStream)

    // 普通工具按 isConcurrencySafe 分批：连续安全批并发，其余串行
    type NormalResult = { toolUse: typeof normalBlocks[0]; output: string; isError: boolean }
    const normalResults: NormalResult[] = []

    // 将 normalBlocks 切分为批次：相邻全为并发安全的合并一批，否则独立一批
    const batches: (typeof normalBlocks)[] = []
    for (const toolUse of normalBlocks) {
      const tool = findTool(toolUse.name)
      const safe = tool ? tool.isConcurrencySafe(toolUse.input) : false
      const lastBatch = batches[batches.length - 1]
      const lastSafe  = lastBatch
        ? findTool(lastBatch[0]!.name)?.isConcurrencySafe(lastBatch[0]!.input) ?? false
        : false
      if (safe && lastSafe && lastBatch) {
        lastBatch.push(toolUse)
      } else {
        batches.push([toolUse])
      }
    }

    for (const batch of batches) {
      const batchSafe = findTool(batch[0]!.name)?.isConcurrencySafe(batch[0]!.input) ?? false
      const runOne = async (toolUse: typeof batch[0]): Promise<NormalResult> => {
        // 被输出上限截断在中途的工具调用：入参残缺，执行 = 写空文件/错误状态。直接拒绝并提示分块重试。
        if (incompleteToolIds.has(toolUse.id)) {
          return { toolUse, output: truncatedToolError(toolUse.name), isError: true }
        }
        const tool = findTool(toolUse.name)
        if (!tool) return { toolUse, output: `Tool not found: "${toolUse.name}"`, isError: true }
        const ctx: ToolContext = { ...toolCtx, mode: getMode() }
        // 框架层 orbit 拦截：isReadOnly(input) 动态判断，false → 拦截写操作
        if (ctx.mode === 'orbit' && !tool.isReadOnly(toolUse.input)) {
          return {
            toolUse,
            output: `[orbit mode] ${tool.name} blocked — write operation not allowed. Use ExitOrbitMode to present your plan first.`,
            isError: true,
          }
        }
        // 框架层 counsel 拦截：方向确认 + 开工确认 两道闸都过之前，禁止任何写/执行类工具。
        // 只读工具（Read/Glob/Grep…）放行，供模型先扫描项目；逃生口是调用 AskUserQuestion。
        if (ctx.mode === 'counsel' && !tool.isReadOnly(toolUse.input) && !(counselConsulted && counselStartConfirmed)) {
          return {
            toolUse,
            output: `[counsel mode] ${tool.name} blocked — confirm the direction with the user first. Call AskUserQuestion to ask strategic multiple-choice question(s) about scope / approach / trade-offs, then proceed once the user has answered.`,
            isError: true,
          }
        }
        try {
          const result = await tool.call(toolUse.input, ctx)
          // 用户已完成方向确认 → 紧接着问"是否现在开始执行"（counsel 第二道闸）
          if (tool.name === 'AskUserQuestion' && !result.isError) {
            counselConsulted = true
            if (ctx.mode === 'counsel' && !counselStartConfirmed) {
              const go = await ask(
                'Direction confirmed. Start executing now? / 方向已确认，现在开始执行吗？',
                ['yes — start executing now', 'no — keep discussing'],
              )
              const ans = go.trim().toLowerCase()
              // 空答复（无 UI 监听）视为放行，避免死锁；'no…' 保持闸闭
              counselStartConfirmed = ans === '' || ans.startsWith('y') || ans.startsWith('1')
            }
          }
          return { toolUse, output: result.output, isError: result.isError ?? false }
        } catch (err: unknown) {
          return { toolUse, output: `Tool execution error: ${String(err)}`, isError: true }
        }
      }

      if (batchSafe) {
        normalResults.push(...await Promise.all(batch.map(runOne)))
      } else {
        for (const toolUse of batch) {
          normalResults.push(await runOne(toolUse))
        }
      }
    }

    // 流式工具顺序执行，每个 chunk 都 yield tool_progress
    const streamingResults: Array<{ toolUse: typeof toolUseBlocks[0]; output: string; isError: boolean }> = []
    for (const toolUse of streamingBlocks) {
      if (incompleteToolIds.has(toolUse.id)) {
        streamingResults.push({ toolUse, output: truncatedToolError(toolUse.name), isError: true })
        continue
      }
      const tool = findTool(toolUse.name)!
      const ctx: ToolContext = { ...toolCtx, mode: getMode() }
      let output: string
      let isError: boolean
      // 框架层 orbit 拦截（流式工具同样适用）
      if (ctx.mode === 'orbit' && !tool.isReadOnly(toolUse.input)) {
        streamingResults.push({
          toolUse,
          output: `[orbit mode] ${tool.name} blocked — write operation not allowed. Use ExitOrbitMode to present your plan first.`,
          isError: true,
        })
        continue
      }
      // 框架层 counsel 拦截（流式工具同样适用）：两道闸都过之前禁止写/执行
      if (ctx.mode === 'counsel' && !tool.isReadOnly(toolUse.input) && !(counselConsulted && counselStartConfirmed)) {
        streamingResults.push({
          toolUse,
          output: `[counsel mode] ${tool.name} blocked — confirm the direction with the user via AskUserQuestion first, then proceed once answered.`,
          isError: true,
        })
        continue
      }
      try {
        const gen = tool.callStream!(toolUse.input, ctx)
        let next: IteratorResult<string, import('./tools/Tool.js').ToolCallResult>
        do {
          next = await gen.next()
          if (!next.done && next.value) {
            yield { type: 'tool_progress', id: toolUse.id, name: toolUse.name, chunk: next.value }
          }
        } while (!next.done)
        output = next.value.output
        isError = next.value.isError ?? false
      } catch (err: unknown) {
        output = `Tool execution error: ${String(err)}`
        isError = true
      }
      streamingResults.push({ toolUse, output, isError })
    }

    // 按原始顺序合并结果并 yield tool_result
    const allResults = [...normalResults, ...streamingResults].sort(
      (a, b) => toolUseBlocks.indexOf(a.toolUse) - toolUseBlocks.indexOf(b.toolUse),
    )

    for (const { toolUse, output, isError } of allResults) {
      yield { type: 'tool_result', id: toolUse.id, name: toolUse.name, input: toolUse.input, output, isError }
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: output,
        is_error: isError || undefined,
      })
    }

    // Build user message: tool_results + any pending task_notifications as text blocks
    const pendingNotifs = drainNotifications()
    const extraTextBlocks: TextBlock[] = pendingNotifs.map(n => ({ type: 'text', text: n }))

    // counsel 强制注入：本轮出现了因未问用户而被拦截的写/执行操作
    // → 在下一轮的 user message 里追加强制指令，模型没有退路，必须先调 AskUserQuestion
    const counselWasBlocked = !(counselConsulted && counselStartConfirmed) && allResults.some(
      r => r.isError && r.output.startsWith('[counsel mode]'),
    )
    if (counselWasBlocked) {
      extraTextBlocks.push({
        type: 'text',
        text: '[Counsel mode enforcement] You attempted a write/execute action without first consulting the user. MANDATORY: your very next action must be to call AskUserQuestion with an options[] array. Ask about scope, format, style, or priorities — whatever is strategically relevant for this task. Do NOT produce any text summary or proceed with any non-read-only tool until you have called AskUserQuestion and the user has answered.',
      })
    }

    // ── 5. 把 assistant + tool_results 追加到历史，进入下一轮 ──────────────
    const toolResultMessage: UserMessage = {
      role: 'user',
      content: [...toolResultBlocks, ...extraTextBlocks],
    }

    messages = [...messages, assistantMessage, toolResultMessage]

    // 通道 B 节奏（#26）：每个 turn 末推进节流计数；/goal 长跑中每 N turn 补一次增量提取，
    // 避免目标完成时面对超长 span 一次性复盘。fire-and-forget。
    if (memoryExtractionOn) {
      noteExtractionTurn()
      if (getActiveGoal()) maybeExtractMemories({ messages, system, cwd })
    }

    // ESC 中止（工具执行阶段）：完整保存本轮结果后停止
    if (options.abortSignal?.aborted) {
      yield { type: 'done', messages }
      return
    }

    // ── 6. maxTurns 保护 ───────────────────────────────────────────────────
    if (turnCount >= turnCap()) {
      yield { type: 'max_turns_reached', maxTurns: turnCap() }
      yield { type: 'done' as const, messages }
      return
    }

    turnCount++
  }
}

// 取最近一条用户消息的文本（跳过纯 tool_result 的 user 消息）—— 召回的 query。
function latestUserText(msgs: (UserMessage | AssistantMessage)[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m || m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    const texts = m.content.filter((b): b is TextBlock => b.type === 'text').map(b => b.text)
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

// 近期 assistant 调过的工具名（去重，最多 limit 个）—— 喂给召回做 recentTools 去噪。
function recentToolNames(msgs: (UserMessage | AssistantMessage)[], limit = 8): string[] {
  const names: string[] = []
  for (let i = msgs.length - 1; i >= 0 && names.length < limit; i--) {
    const m = msgs[i]
    if (!m || m.role !== 'assistant') continue
    for (const b of m.content) {
      if (b.type === 'tool_use' && !names.includes(b.name)) names.push(b.name)
    }
  }
  return names
}

// 剥掉对话数组里的 <system-reminder> 用户消息（reminder 仅每轮新鲜前置，不该持久累积）。
function stripReminders(
  msgs: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  return msgs.filter(
    m => !(m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<system-reminder>')),
  )
}

// ─────────────────────────── /goal 继续指令 ─────────────────────────────────
// 目标未达成时注入给模型的下一轮指令：把 condition 重申为指令，并带上
// evaluator 的理由作为针对性指引（对齐文档"includes the reason as guidance"）。
function buildGoalDirective(condition: string, reason: string): string {
  return [
    '[/goal] Your active goal is NOT yet satisfied — keep working, do not return control to the user.',
    '',
    'Goal condition:',
    condition,
    '',
    "Evaluator feedback (why it's not met yet):",
    reason,
    '',
    'Take the next concrete action toward the condition. Prove progress through your output ' +
      '(run the command, show the result, count the files). Do not ask for confirmation or stop ' +
      'until the condition is demonstrably met in the transcript. If you believe it is already met, ' +
      'state explicitly which evidence in your output proves it.',
  ].join('\n')
}

// ─────────────────────────── 截断恢复指令 ───────────────────────────────────
// 纯文本输出撞 max_tokens 被截断时注入：让模型从断点无缝续写。
function buildContinuationDirective(): string {
  return [
    '[system] Your previous message was cut off because it hit the output token limit — it is incomplete.',
    'Continue from exactly where you stopped. Do not repeat what you already wrote, do not restart, ' +
      'and do not apologize — just resume the next character as if there was no interruption.',
  ].join('\n')
}

// 工具调用被截断在中途时回传给模型的 tool_result。入参 JSON 残缺，工具未执行。
function truncatedToolError(toolName: string): string {
  return [
    `[truncated] The "${toolName}" call was cut off at the output token limit before its arguments finished streaming.`,
    'NOTHING was executed and NO file was written — the arguments were incomplete.',
    'Recover by splitting the work so each tool call fits the budget:',
    `  • For a large file: call Write with only the FIRST portion, then append the remaining parts with`,
    `    successive Edit calls (or Bash append). Never try to emit the whole large file in one Write again.`,
    '  • Prefer self-contained, compact output (inline SVG/CSS over verbose markup) to stay within budget.',
    'Do not retry the identical oversized call — it will be truncated again.',
  ].join('\n')
}
