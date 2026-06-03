// VigilScheduleTool — 周期性或定时任务（cron 表达式）
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'
import { addTask, ensureDaemon, type VigilTask } from '../../utils/vigilTasks.js'
import { calcNextFireAt } from '../../services/cron-scheduler.js'
import { ask } from '../AskUserQuestionTool/bridge.js'
import { randomUUID } from 'node:crypto'
import { promptNeedsWechat, checkWechatSetup } from '../../utils/wechatSetupGuard.js'

export const VigilScheduleTool = buildTool({
  name: 'VigilSchedule',
  description: `Schedule a RECURRING or fixed-time task using a cron expression.

Use this when the user says things like:
  "every day at 8am, do X"
  "every Monday morning, run Y"
  "at 9pm tonight, then daily"
  "every 30 minutes, check Z"

Do NOT use for one-time delays ("in 5 minutes", "after an hour") — use VigilOnce instead.

CRITICAL — output NOTHING before calling this tool. No "I will schedule", no "Proceeding", no summary, no acknowledgement. The tool itself shows a confirmation dialog that handles all user interaction. Any text output before the tool call will confuse the user into thinking the task was already scheduled before they can confirm.

Common cron patterns:
  "0 8 * * *"     — every day at 08:00
  "0 9 * * 1"     — every Monday at 09:00
  "*/30 * * * *"  — every 30 minutes
  "0 8,18 * * *"  — twice daily at 08:00 and 18:00

Before calling this tool, always tell the user what you are about to schedule and let them confirm.`,
  isReadOnly: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Human-readable description of what this task does',
      },
      cron: {
        type: 'string',
        description: 'Cron expression (5 fields: minute hour dom month dow)',
      },
      prompt: {
        type: 'string',
        description: 'The exact prompt Astraea will execute when this task fires. IMPORTANT: preserve all names and identifiers in their original language — never transliterate (e.g. write "李嘉俊" not "Li Jiajun").',
      },
      recurring: {
        type: 'boolean',
        description: 'true = repeat on schedule (default); false = run once at the next cron match',
        default: true,
      },
    },
    required: ['description', 'cron', 'prompt'],
  },

  async call(input, _ctx: ToolContext): Promise<ToolCallResult> {
    const description = input['description'] as string
    const cron        = input['cron']        as string
    const prompt      = input['prompt']      as string
    const recurring   = (input['recurring'] as boolean) ?? true

    // WeChat 任务：提前检测 setup 状态，避免注册后才在执行时失败
    if (promptNeedsWechat(prompt)) {
      const setupError = checkWechatSetup()
      if (setupError) return { output: setupError, isError: true }
    }

    let nextFireAt: number
    try {
      nextFireAt = calcNextFireAt(cron)
    } catch (err) {
      return { output: `Invalid cron expression: ${err}`, isError: true }
    }

    const nextFireStr = new Date(nextFireAt).toLocaleString()

    // ── Guardrail C: 硬性确认 ────────────────────────────────────────────────
    const confirmMsg = [
      `${recurring ? 'Recurring' : 'One-time cron'} task to schedule:`,
      `  Description: ${description}`,
      `  Cron:        ${cron} (${recurring ? 'repeating' : 'fires once'})`,
      `  Next fire:   ${nextFireStr}`,
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
      cron,
      prompt,
      description,
      recurring,
      durable: true,
      nextFireAt,
      createdAt: Date.now(),
      cwd: process.cwd(),
    }

    addTask(task)
    const wasRunning = ensureDaemon()

    // ── Guardrail D: 撤销提示 ────────────────────────────────────────────────
    return {
      output: [
        `${recurring ? 'Recurring' : 'One-time cron'} task scheduled: "${description}"`,
        `  ID:         ${task.id}`,
        `  Cron:       ${cron}`,
        `  Recurring:  ${recurring}`,
        `  Next fire:  ${nextFireStr}`,
        `  Daemon:     ${wasRunning ? 'already running' : 'started'}`,
        ``,
        `To cancel: use VigilDelete with id="${task.id}"`,
      ].join('\n'),
    }
  },
})
