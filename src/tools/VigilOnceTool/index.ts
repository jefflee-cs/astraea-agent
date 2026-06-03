// VigilOnceTool — 一次性延迟任务：N 分钟后执行一次，执行完自动删除
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'
import { addTask, ensureDaemon, type VigilTask } from '../../utils/vigilTasks.js'
import { ask } from '../AskUserQuestionTool/bridge.js'
import { randomUUID } from 'node:crypto'
import { promptNeedsWechat, checkWechatSetup } from '../../utils/wechatSetupGuard.js'

export const VigilOnceTool = buildTool({
  name: 'VigilOnce',
  description: `Schedule a ONE-TIME task to run after a delay (in minutes). The task fires exactly once, then is automatically removed.

Use this when the user says things like:
  "in 5 minutes, do X"
  "remind me in an hour to Y"
  "after 30 minutes, run Z"

Do NOT use for recurring tasks ("every day", "each morning", "weekly") — use VigilSchedule instead.

CRITICAL — output NOTHING before calling this tool. No "I will schedule", no "Proceeding", no summary, no acknowledgement. The tool itself shows a confirmation dialog that handles all user interaction. Any text output before the tool call will confuse the user into thinking the task was already scheduled before they can confirm.`,
  isReadOnly: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Human-readable description of what this task does',
      },
      delaySeconds: {
        type: 'number',
        description: 'How many seconds from now to wait before executing (minimum: 10)',
      },
      prompt: {
        type: 'string',
        description: 'The exact prompt Astraea will execute when this task fires. IMPORTANT: preserve all names and identifiers in their original language — never transliterate (e.g. write "李嘉俊" not "Li Jiajun").',
      },
    },
    required: ['description', 'delaySeconds', 'prompt'],
  },

  async call(input, _ctx: ToolContext): Promise<ToolCallResult> {
    const description  = input['description']  as string
    const delaySeconds = input['delaySeconds'] as number
    const prompt       = input['prompt']       as string

    if (!Number.isFinite(delaySeconds) || delaySeconds < 10) {
      return { output: 'delaySeconds must be ≥ 10', isError: true }
    }

    if (promptNeedsWechat(prompt)) {
      const setupError = checkWechatSetup()
      if (setupError) return { output: setupError, isError: true }
    }

    const fireAt = Date.now() + Math.round(delaySeconds) * 1_000
    const fireAtStr = new Date(fireAt).toLocaleString()

    // ── Guardrail C: 硬性确认 ────────────────────────────────────────────────
    const confirmMsg = [
      `One-time task to schedule:`,
      `  Description: ${description}`,
      `  Scheduled:   ${fireAtStr}`,
      `  Prompt:      ${prompt.length > 120 ? prompt.slice(0, 120) + '…' : prompt}`,
      ``,
      `Proceed?`,
    ].join('\n')

    const answer = await ask(confirmMsg, ['Yes', 'No'])
    if (!answer.trim().toLowerCase().startsWith('y')) {
      return { output: 'Task scheduling cancelled by user.' }
    }

    const task: VigilTask = {
      id: randomUUID(),
      prompt,
      description,
      recurring: false,
      durable: true,
      nextFireAt: fireAt,
      createdAt: Date.now(),
      cwd: process.cwd(),
    }

    addTask(task)
    const wasRunning = ensureDaemon()

    // ── Guardrail D: 撤销提示 ────────────────────────────────────────────────
    return {
      output: [
        `One-time task scheduled: "${description}"`,
        `  ID:        ${task.id}`,
        `  Fires at:  ${fireAtStr} (in ${delaySeconds}s)`,
        `  Daemon:    ${wasRunning ? 'already running' : 'started'}`,
        ``,
        `To cancel before it fires: use VigilDelete with id="${task.id}"`,
      ].join('\n'),
    }
  },
})
