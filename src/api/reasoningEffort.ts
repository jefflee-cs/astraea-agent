// 规则大脑 —— /reason 指令的"决策核心"，对应 effort 指令里的 src/utils/effort.ts。
// 三件事：① 按优先级链算出最终生效的 effort；② 决定哪些值能落盘；③ 把 effort 翻成
// 各 provider 的原生请求参数（带安全兜底，永不让 API 报 400）。
//
// 全部是纯函数，便于单测（合同 AC1）。不在此读写磁盘、不碰网络。

import {
  type ReasoningEffort,
  isReasoningEffort,
  getSessionEffort,
} from '../state/reasoningEffort'

export type { ReasoningEffort }

// ─── ① 优先级链：env > 会话 > undefined ──────────────────────────────────────
// 对应 effort 的 resolveAppliedEffort。Astraea v1 不设"模型默认等级"——没设就 undefined，
// 即不下发任何 reasoning 参数，交给 provider 自己的默认值，行为最可预测。

const ENV_KEY = 'ASTRAEA_REASONING_EFFORT'

// 返回三态：
//   undefined          —— env 未设，继续问会话值
//   null               —— env 显式 auto/unset，强制"不下发 effort"（覆盖会话值）
//   ReasoningEffort     —— env 强制某等级（最高优先级，CI/管理员用）
export function getEffortEnvOverride(): ReasoningEffort | null | undefined {
  const raw = process.env[ENV_KEY]?.trim().toLowerCase()
  if (!raw) return undefined
  if (raw === 'auto' || raw === 'unset') return null
  if (isReasoningEffort(raw)) return raw
  return undefined // 无法识别的值视为未设，回落到会话值
}

/** 算出本次请求最终生效的 effort（undefined = 不下发任何 reasoning 参数）。 */
export function resolveAppliedEffort(
  session: ReasoningEffort | undefined = getSessionEffort(),
): ReasoningEffort | undefined {
  const env = getEffortEnvOverride()
  if (env === null) return undefined // env 强制 auto，压过会话设置
  return env ?? session ?? undefined
}

/** 给 /reason "查看当前"用：报告生效值与来源。 */
export function currentEffortStatus(
  session: ReasoningEffort | undefined = getSessionEffort(),
): { effort: ReasoningEffort | undefined; source: 'env' | 'session' | 'auto' } {
  const env = getEffortEnvOverride()
  if (env === null) return { effort: undefined, source: 'env' }
  if (env !== undefined) return { effort: env, source: 'env' }
  if (session !== undefined) return { effort: session, source: 'session' }
  return { effort: undefined, source: 'auto' }
}

// ─── ② 持久化过滤：low/medium/high 落盘，max 仅会话 ───────────────────────────
// 对应 effort 的 toPersistableEffort。max 是"最强档"，只在本次会话生效，重启即失，
// 避免有人手改 settings.json 把高开销档偷偷永久化。

export function toPersistableEffort(value: ReasoningEffort): ReasoningEffort | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') return value
  return undefined // 'max' → 不落盘
}

// ─── ③ 出口：provider-aware 映射（安全兜底，永不抛错）────────────────────────

// OpenAI：reasoning_effort 仅 o 系 / gpt-5.x 接受（其余模型传了会 400），max 无对应档 → 降到 high。
// 注：与 src/api/openai.ts:isReasoningModel 保持同一判定；此处自带正则以免模块循环依赖。
function isOpenAiReasoningModel(model: string): boolean {
  return /^o\d/i.test(model) || /^gpt-5/i.test(model)
}

export function openaiReasoningParam(
  model: string,
  effort: ReasoningEffort | undefined,
): { reasoning_effort?: 'low' | 'medium' | 'high' } {
  if (!effort) return {}
  if (!isOpenAiReasoningModel(model)) return {} // 非推理模型：略过，避免 400
  const level = effort === 'max' ? 'high' : effort // max → high 安全降级
  return { reasoning_effort: level }
}

// Anthropic：extended thinking。仅 Claude 4 系 / 3.7 支持；budget_tokens 必须 1024 ≤ N < max_tokens。
export function anthropicSupportsThinking(model: string): boolean {
  return /^claude-(sonnet-4|opus-4|3-7)/i.test(model)
}

const ANTHROPIC_BUDGET: Record<ReasoningEffort, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  max: 32768,
}

export function anthropicThinkingParam(
  model: string,
  effort: ReasoningEffort | undefined,
  maxTokens: number,
): { thinking?: { type: 'enabled'; budget_tokens: number } } {
  if (!effort) return {}
  if (!anthropicSupportsThinking(model)) return {}
  const target = ANTHROPIC_BUDGET[effort]
  // budget 必须 < max_tokens，且给输出留 ≥1024 余量。空间不够就不启用（兜底，不报错）。
  const budget = Math.min(target, maxTokens - 1024)
  if (budget < 1024) return {}
  return { thinking: { type: 'enabled', budget_tokens: budget } }
}

// DeepSeek 定制：没有 per-request reasoning 旋钮，只有两个真实杠杆 ——
//   ① 换模型（deepseek-chat ↔ deepseek-reasoner）：auto/low 不开推理，medium+ 开 reasoner；
//   ② 动态 prompt：reasoner 内部 medium/high/max 靠递进的"思考深度"指令区分（软杠杆）。
// 不动 max_tokens：DeepSeek 把 CoT 放在独立的 reasoning_content 字段、不占 max_tokens，
// 且 reasoner 输出硬上限 8192，抬高既无益又可能 400。
//
// Ollama 同样无 reasoning 旋钮，这些函数对它也安全（默认走 chat 分支 / 返回 undefined）。

export const DEEPSEEK_CHAT_MODEL = 'deepseek-chat'
export const DEEPSEEK_REASONER_MODEL = 'deepseek-reasoner'

/** 该等级在 DeepSeek 上是否需要 reasoner（→ 需换模型 + REPL 确认）。auto(undefined)/low → 否。 */
export function deepseekUsesReasoner(effort: ReasoningEffort | undefined): boolean {
  return effort === 'medium' || effort === 'high' || effort === 'max'
}

/** 解析 DeepSeek 本次请求实际用的模型：reasoner 档 → deepseek-reasoner，否则用配置模型。 */
export function deepseekEffectiveModel(
  effort: ReasoningEffort | undefined,
  configured: string,
): string {
  return deepseekUsesReasoner(effort) ? DEEPSEEK_REASONER_MODEL : configured
}

/** reasoner 内部分档的动态 prompt 指令（追加到 system）。auto/low → undefined（不注入）。 */
export function deepseekReasoningDirective(
  effort: ReasoningEffort | undefined,
): string | undefined {
  switch (effort) {
    case 'medium':
      return '请逐步推理后再作答。'
    case 'high':
      return '请仔细推理：先分解问题，考虑边界与异常情况，再给出结论。'
    case 'max':
      return '请进行充分严谨的推理：枚举可能的方案与反例，逐一权衡，并在作答前自我校验结论的正确性。'
    default:
      return undefined // low / auto：不注入
  }
}
