// 进程级 /goal 单例 —— 会话作用域的"完成条件"状态机
//
// 设计意图（对齐 sessionMode 的单例模式）：
//   /goal 设定一个可验证的完成条件，Astraea 在每个 turn 结束后由一个
//   小快模型（evaluator）判断条件是否成立。未成立 → 自动继续下一个 turn，
//   不交还控制权；成立 → 自动清除目标，记录一条"已达成"。
//
//   状态是进程级单例 —— query.ts（Stop-hook）、App.tsx（REPL UI）、cli.ts
//   (`-p` 模式) 三处共享同一份，无需穿参，与 getMode()/getActiveGoal() 一致。

// ── 安全上限 ──────────────────────────────────────────────────────────────────
// 即便 evaluator 始终判定"未达成"，目标循环也不会无限跑：达到 GOAL_MAX_TURNS
// 后强制停止并交还控制权。condition 本身也可以写 "or stop after N turns"，由
// evaluator 依据 transcript 判定 —— 这是双重保险。
export const GOAL_MAX_TURNS = 40

// condition 最大长度（与文档一致）
export const GOAL_MAX_CONDITION_LENGTH = 4000

// /goal clear 的别名
export const GOAL_CLEAR_ALIASES = ['clear', 'stop', 'off', 'reset', 'none', 'cancel'] as const

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface GoalState {
  /** 完成条件（最多 4000 字符） */
  condition: string
  /** 设定时间戳（ms） */
  startedAt: number
  /** evaluator 已评估的 turn 数 */
  turnsEvaluated: number
  /** 自目标设定以来累计的输出 token 花费 */
  tokenSpend: number
  /** evaluator 最近一次给出的理由 */
  lastReason: string | null
  status: 'active'
}

export interface AchievedGoal {
  condition: string
  durationMs: number
  turns: number
  tokenSpend: number
  reason: string
  achievedAt: number
}

// ── 单例存储 ──────────────────────────────────────────────────────────────────

let _active: GoalState | null = null
let _lastAchieved: AchievedGoal | null = null

// ── 读写 API ──────────────────────────────────────────────────────────────────

export function getActiveGoal(): GoalState | null {
  return _active
}

export function isGoalActive(): boolean {
  return _active !== null
}

export function getLastAchieved(): AchievedGoal | null {
  return _lastAchieved
}

/**
 * 设定（或替换）当前目标。返回规范化后的 condition；condition 为空时返回 null。
 * 设定新目标会清空上一条"已达成"记录吗？不会 —— 已达成记录独立保留，
 * 仅在又一个目标达成时被覆盖。
 */
export function setGoal(rawCondition: string): GoalState | null {
  const condition = rawCondition.trim().slice(0, GOAL_MAX_CONDITION_LENGTH)
  if (!condition) return null
  _active = {
    condition,
    startedAt: Date.now(),
    turnsEvaluated: 0,
    tokenSpend: 0,
    lastReason: null,
    status: 'active',
  }
  return _active
}

/**
 * 记录一次 evaluator 评估结果。met=false 时仅累加计数与理由；
 * 调用方负责据此决定是否继续循环。tokenSpendCumulative 为累计输出 token。
 */
export function recordGoalEvaluation(reason: string, tokenSpendCumulative: number): void {
  if (!_active) return
  _active.turnsEvaluated += 1
  _active.lastReason = reason
  _active.tokenSpend = tokenSpendCumulative
}

/** 目标达成：把 active 移入"已达成"记录并清空 active。 */
export function markGoalAchieved(reason: string): AchievedGoal | null {
  if (!_active) return null
  const achieved: AchievedGoal = {
    condition: _active.condition,
    durationMs: Date.now() - _active.startedAt,
    turns: _active.turnsEvaluated,
    tokenSpend: _active.tokenSpend,
    reason,
    achievedAt: Date.now(),
  }
  _lastAchieved = achieved
  _active = null
  return achieved
}

/** 主动清除 active 目标（/goal clear、/clear、达到安全上限时调用）。返回被清除的目标。 */
export function clearGoal(): GoalState | null {
  const cleared = _active
  _active = null
  return cleared
}
