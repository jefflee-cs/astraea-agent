// 通道 B：后台 forked agent 兜底提取 —— 定稿 §4。
//
// 主代理干活时常忘记沉淀记忆；通道 B 在 query loop 末（done）与 /goal 长跑中每 N turn
// 复盘对话、补抓记忆。设计要点：
//   #15 真 forked agent：克隆父消息共享 prompt cache（同 system + 同 messages），跑主模型
//   #16 index 计数游标互斥：主代理写过的段，整段跳过并推进游标
//   #17 重入锁 + 轮次节流 + 合并尾随（尾随不节流）
//   #18 watchdog 硬超时 + abort + fire-and-forget；游标只在成功后推进，失败下轮重试
//   #19 整段跳过（粗粒度互斥）
//   #25 写入后发「已保存记忆」通知

import { streamMessage } from '../api/stream'
import type {
  AssistantMessage,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  UserMessage,
} from '../types/message'
import type { Tool, ToolSchema } from '../tools/Tool'
import { FileWriteTool } from '../tools/FileWriteTool'
import { FileReadTool } from '../tools/FileReadTool'
import { FileEditTool } from '../tools/FileEditTool'
import { GlobTool } from '../tools/GlobTool'
import { GrepTool } from '../tools/GrepTool'
import { enqueueNotification } from '../services/notification-queue'
import { getMemoryDir, isAnyMemoryPath } from './paths'
import { formatMemoryManifest, scanMemoryFiles } from './scan'

const MAX_EXTRACT_TURNS = 5 // #15：正常 2-4 turn 完成（read→write），硬上限防验证兔子洞
const WATCHDOG_MS = 60_000 // #18：壁钟超时（§8 待定，暂定 60s）
const TURN_THRESHOLD = 8 // #26：/goal 每 N turn 补一次（§8 待定）

// 提取 agent 只用记忆工具；非记忆写会被 fileWriteGate 在非交互下 fail-closed deny（安全网）。
const MEMORY_TOOLS: readonly Tool[] = [FileWriteTool, FileReadTool, FileEditTool, GlobTool, GrepTool]

export type ExtractCtx = {
  messages: (UserMessage | AssistantMessage)[]
  system: string
  cwd: string
}

// ── 运行时状态（单主对话；导出 reset 供测试）──────────────────────────────────
let inProgress = false
let pending: ExtractCtx | null = null
let cursor = 0 // 已复盘到的消息 index（计数游标，#16）
let turnsSinceExtract = 0

export function resetExtractState(): void {
  inProgress = false
  pending = null
  cursor = 0
  turnsSinceExtract = 0
}

/** 压缩重建消息数组后，把游标 clamp 到当前末尾（连带前置 #3）。 */
export function clampExtractCursor(messageCount: number): void {
  if (cursor > messageCount) cursor = messageCount
}

/** 每个 turn 末调用：推进节流计数。 */
export function noteExtractionTurn(): void {
  turnsSinceExtract++
}

/** /goal 节奏：达到 N turn 阈值才补一次（节流，fire-and-forget）。 */
export function maybeExtractMemories(ctx: ExtractCtx): void {
  if (turnsSinceExtract < TURN_THRESHOLD) return
  void runExtraction(ctx)
}

/** done 分支：强制提取一次（fire-and-forget，尾随不节流）。 */
export function forceExtractMemories(ctx: ExtractCtx): void {
  void runExtraction(ctx)
}

// ── 重入 + 合并尾随（#17）────────────────────────────────────────────────────
async function runExtraction(ctx: ExtractCtx): Promise<void> {
  if (inProgress) {
    pending = ctx // 暂存最新上下文，当前 run 结束后跑一次尾随
    return
  }
  inProgress = true
  try {
    await doExtractOnce(ctx)
  } catch {
    // doExtractOnce 内部已吞错；这里兜底，绝不让后台异常冒泡。
  } finally {
    turnsSinceExtract = 0
    inProgress = false
    if (pending) {
      const next = pending
      pending = null
      void runExtraction(next) // 尾随：处理已提交的工作，不受节流约束
    }
  }
}

async function doExtractOnce(ctx: ExtractCtx): Promise<void> {
  const { messages, system, cwd } = ctx
  if (messages.length <= cursor) return // 无新消息

  // 互斥（#19）：游标之后主代理已写过记忆 → 整段跳过并推进游标。
  if (hasMemoryWritesSince(messages, cursor)) {
    cursor = messages.length
    return
  }

  const memoryDir = getMemoryDir(cwd)
  const manifest = formatMemoryManifest(await scanMemoryFiles(memoryDir))
  const instruction = buildExtractionInstruction(memoryDir, manifest)

  // watchdog（#18）：壁钟超时强制 abort；失败游标不动，下轮重试同段。
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), WATCHDOG_MS)
  try {
    const wrote = await forkedExtractAgent(messages, instruction, system, ctrl.signal)
    if (ctrl.signal.aborted) return // 超时：不推进游标
    cursor = messages.length // 成功才推进（#18）
    if (wrote) {
      enqueueNotification('<system-reminder>📝 已沉淀记忆（后台复盘本轮对话）。</system-reminder>')
    }
  } catch {
    // 失败：游标不动，下轮重试。
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 游标之后是否有主代理写记忆（assistant 的 Write/Edit tool_use，file_path 落在记忆子树）。
 * 命中即整段跳过 forked agent（#19）。
 */
export function hasMemoryWritesSince(
  messages: (UserMessage | AssistantMessage)[],
  fromIndex: number,
): boolean {
  for (let i = Math.max(0, fromIndex); i < messages.length; i++) {
    const m = messages[i]
    if (!m || m.role !== 'assistant') continue
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue
      if (b.name !== FileWriteTool.name && b.name !== FileEditTool.name) continue
      const fp = (b.input as Record<string, unknown>)['file_path']
      if (typeof fp === 'string' && isAnyMemoryPath(fp)) return true
    }
  }
  return false
}

function buildExtractionInstruction(memoryDir: string, manifest: string): string {
  return [
    '[memory extraction — background review]',
    'Review ONLY the most recent portion of this conversation and persist any durable memories,',
    'following the memory rules already in your system prompt (four types, what NOT to save,',
    'two-step save: write the file then add a one-line pointer to MEMORY.md).',
    '',
    'Only save information that will be useful in FUTURE conversations and is NOT derivable from',
    'the current code/git/AGENTS.md. If nothing is worth saving, do nothing and stop — do not',
    'invent memories. Prefer updating an existing memory over creating a near-duplicate.',
    '',
    `Memory directory: ${memoryDir}`,
    manifest ? `Existing memories:\n${manifest}` : 'Existing memories: (none yet)',
  ].join('\n')
}

/**
 * 真 forked agent（#15）：seed = [...父消息, 提取指令]，同 system → 共享 prompt cache。
 * 跑主模型（streamMessage 默认），工具限定记忆工具集，maxTurns 5。
 * 返回是否写过记忆文件（用于通知）。
 */
async function forkedExtractAgent(
  parentMessages: (UserMessage | AssistantMessage)[],
  instruction: string,
  system: string,
  signal: AbortSignal,
): Promise<boolean> {
  const toolSchemas: ToolSchema[] = MEMORY_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))

  let messages: (UserMessage | AssistantMessage)[] = [
    ...parentMessages,
    { role: 'user', content: instruction },
  ]
  let wroteMemory = false

  for (let turn = 0; turn < MAX_EXTRACT_TURNS; turn++) {
    if (signal.aborted) break

    const contentBlocks: (TextBlock | ToolUseBlock)[] = []
    const toolUseBlocks: ToolUseBlock[] = []

    for await (const event of streamMessage(messages, {
      system,
      tools: toolSchemas,
      abortSignal: signal,
      enablePromptCaching: true, // #15：同 system + 同父消息前缀 → 命中父对话 prompt cache
    })) {
      if (signal.aborted) break
      if (event.type === 'text') {
        const last = contentBlocks.at(-1)
        if (last?.type === 'text') last.text += event.text
        else contentBlocks.push({ type: 'text', text: event.text })
      } else if (event.type === 'tool_use') {
        const block: ToolUseBlock = { type: 'tool_use', id: event.id, name: event.name, input: event.input }
        contentBlocks.push(block)
        toolUseBlocks.push(block)
      }
    }
    if (signal.aborted) break

    const assistantMessage: AssistantMessage = { role: 'assistant', content: contentBlocks }
    if (toolUseBlocks.length === 0) break // 无工具调用 → 提取完成

    const toolResultBlocks: ToolResultBlock[] = []
    for (const toolUse of toolUseBlocks) {
      if (signal.aborted) break
      const tool = MEMORY_TOOLS.find(t => t.name === toolUse.name)
      let output: string
      let isError = false
      if (!tool) {
        output = `Tool not available in extraction: "${toolUse.name}"`
        isError = true
      } else {
        try {
          // 非交互（无人在场）：遇 ask 一律 fail-closed deny；记忆写经豁免直接放行。
          const res = await tool.call(toolUse.input, { mode: 'default', isInteractive: false, agentId: 'memory-extract' })
          output = res.output
          isError = res.isError ?? false
          if (
            !isError &&
            (toolUse.name === FileWriteTool.name || toolUse.name === FileEditTool.name)
          ) {
            const fp = (toolUse.input as Record<string, unknown>)['file_path']
            if (typeof fp === 'string' && isAnyMemoryPath(fp)) wroteMemory = true
          }
        } catch (err) {
          output = `Tool error: ${String(err)}`
          isError = true
        }
      }
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: output,
        is_error: isError || undefined,
      })
    }

    messages = [...messages, assistantMessage, { role: 'user', content: toolResultBlocks }]
  }

  return wroteMemory
}
