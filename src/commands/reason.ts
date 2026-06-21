// /reason 指令的"行为"层 —— 对应 effort 指令的 effort.tsx 的 call()/executeEffort()。
// 解析参数 → 改会话单例 → 给出落盘指示（由 run() 异步执行）→ 回一句反馈。
//
// 设计为同步纯逻辑（磁盘写在 persistReason 里），便于单测（合同 AC2）。

import { config } from '../config'
import {
  isReasoningEffort,
  setSessionEffort,
  unsetSessionEffort,
  type ReasoningEffort,
} from '../state/reasoningEffort'
import {
  currentEffortStatus,
  toPersistableEffort,
  deepseekUsesReasoner,
  DEEPSEEK_REASONER_MODEL,
} from '../api/reasoningEffort'
import { getSettings, updateSettings } from '../settings'

const HELP = [
  'Usage: /reason [low|medium|high|max|auto]',
  '  low / medium / high   set reasoning effort (persisted across sessions)',
  '  max                   strongest reasoning (this session only — not persisted)',
  '  auto                  clear — follow env / provider default',
  '  (no argument)         show the current effective level + its source',
  '',
  "Maps to each provider's native knob: OpenAI reasoning_effort · Anthropic thinking budget.",
  'DeepSeek / Kimi / Ollama have no per-request reasoning knob (no-op).',
].join('\n')

export function reasonHelp(): string {
  return HELP
}

export type ReasonDisk = 'write' | 'clear' | 'none'
export interface ReasonResult {
  message: string
  disk: ReasonDisk
  value?: ReasoningEffort // 仅 disk==='write' 时有意义
}

export function showReason(): string {
  const { effort, source } = currentEffortStatus()
  const provider = config.provider
  if (!effort) {
    return `Reasoning effort: auto (${source}) — provider '${provider}' uses its own default.`
  }
  // DeepSeek 推理档会换模型，明示之。
  const dsNote =
    provider === 'deepseek' && deepseekUsesReasoner(effort)
      ? ` → model ${DEEPSEEK_REASONER_MODEL}`
      : ''
  return `Reasoning effort: ${effort} (${source}, provider '${provider}')${dsNote}.`
}

/** 解析并执行一次 /reason。改会话单例；磁盘留给 persistReason。 */
export function executeReason(args: string | undefined): ReasonResult {
  // 拆出 flag（--confirm）与位置参数（等级）。
  const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean)
  const confirmed = tokens.some(t => t.toLowerCase() === '--confirm' || t.toLowerCase() === 'confirm')
  const a = (tokens.find(t => !t.startsWith('--') && t.toLowerCase() !== 'confirm') ?? '').toLowerCase()

  if (!a || a === 'current' || a === 'status') return { message: showReason(), disk: 'none' }
  if (a === 'help' || a === '-h' || a === '--help') return { message: HELP, disk: 'none' }

  if (a === 'auto' || a === 'unset') {
    unsetSessionEffort()
    return { message: 'Reasoning effort cleared → auto (env / provider default).', disk: 'clear' }
  }

  if (!isReasoningEffort(a)) {
    return {
      message: `Invalid argument: ${args}. Valid options: low | medium | high | max | auto.`,
      disk: 'none',
    }
  }

  // DeepSeek 专属：reasoner 档（medium/high/max）会换模型，换前要 REPL 两步确认。
  if (config.provider === 'deepseek' && deepseekUsesReasoner(a) && !confirmed) {
    return {
      message: [
        `⚠️ DeepSeek：切到推理档「${a}」需把模型 ${config.deepseek.model} → ${DEEPSEEK_REASONER_MODEL}（本会话）。`,
        `   确认请输入：  /reason ${a} --confirm`,
      ].join('\n'),
      disk: 'none',
    }
  }

  setSessionEffort(a)
  const persistable = toPersistableEffort(a) // max → undefined（仅会话）
  if (persistable === undefined) {
    return { message: `Reasoning effort set to ${a} (this session only — not persisted).`, disk: 'none' }
  }
  return { message: `Reasoning effort set to ${a}.`, disk: 'write', value: persistable }
}

/** run() 调用：把落盘指示真正写进 settings.json。 */
export async function persistReason(r: ReasonResult): Promise<void> {
  if (r.disk === 'write' && r.value) await updateSettings({ reasoningEffort: r.value })
  else if (r.disk === 'clear') await updateSettings({ reasoningEffort: undefined })
}

/** 启动期水合：把上次落盘的等级灌进会话单例（充当会话初值，仍可被 env / 本次 /reason 覆盖）。 */
export function hydrateReasoningEffort(): void {
  const persisted = getSettings().reasoningEffort
  if (persisted && isReasoningEffort(persisted)) setSessionEffort(persisted)
}
