// 上下文窗口与阈值计算 —— 纯函数，无副作用（设计文档 §2/§3/§4）。
//
// 全部按 effectiveWindow 的百分比表达，不用绝对 token buffer：Astraea 窗口跨 8K–1M，
// 任何写死的绝对预留量在小窗口上都会失效。阈值每次现算（从当前激活 provider 的
// contextWindow/maxOutput 取值），所以 /login 换模型后自动生效。

import { activeContextWindow, activeMaxTokens } from '../../config'

// 给输出留位置，保证 输入 + 输出 ≤ contextWindow。
// 预留量以真实 maxOutput 为下界（+ pad 兜 thinking/估算误差），但 cap 在窗口一半，
// 防止"大输出上限 × 小窗口"把 effective window 压到 0。
const SAFETY_PAD = 2_000

export function effectiveWindow(contextWindow: number, maxOutput: number): number {
  const reserved = Math.min(maxOutput + SAFETY_PAD, Math.floor(contextWindow * 0.5))
  return contextWindow - reserved
}

// 三档阶梯比例（× effectiveWindow）。
export const WARNING_RATIO = 0.80      // UI 警告
export const AUTOCOMPACT_RATIO = 0.92  // 自动压缩触发
export const BLOCKING_RATIO = 0.98     // 硬阻塞（仅 autocompact 关闭时）

// Eclipse（上下文折叠）阶梯比例（× effectiveWindow）。跨在 autocompact(0.92) 两侧：
//   0.80 warning → 0.85 commit(吃 staged 存货,非阻塞) → 0.92 autocompact(被压制)
//   → 0.95 blocking(存货不够,同步现折,必须等) → 0.98 硬阻塞。
export const ECLIPSE_COMMIT_RATIO   = 0.85  // 提交折叠：吃后台存货，非阻塞
export const ECLIPSE_BLOCKING_RATIO = 0.95  // 阻塞式：存货不够当场现折，主线程必须等
export const ECLIPSE_STAGE_FLOOR    = 0.75  // 起步闸：到此才武装后台 ctx-agent spawn
export const ECLIPSE_SPAWN_DELTA    = 0.08  // 距上次 spawn 又涨这么多(×eff) 才再 spawn
export const ECLIPSE_TAIL_RATIO     = 0.15  // 最近一段 token 预算(×eff)，永不折（保护区）
export const ECLIPSE_MAX_STAGE_RISK = 0.5   // 入队风险上限：risk>此值的敏感段不自动折

// 压缩后落点目标：压缩后总占用（固定开销 + 摘要 + 最近）落在 ⅓ 窗口左右（设计文档 §7）。
export const LANDING_RATIO = 0.35

export interface Thresholds {
  effectiveWindow: number
  warning: number
  autocompact: number
  blocking: number
  eclipseCommit: number
  eclipseBlocking: number
  eclipseStageFloor: number
}

export function thresholds(eff: number): Thresholds {
  return {
    effectiveWindow: eff,
    warning: Math.floor(eff * WARNING_RATIO),
    autocompact: Math.floor(eff * AUTOCOMPACT_RATIO),
    blocking: Math.floor(eff * BLOCKING_RATIO),
    eclipseCommit: Math.floor(eff * ECLIPSE_COMMIT_RATIO),
    eclipseBlocking: Math.floor(eff * ECLIPSE_BLOCKING_RATIO),
    eclipseStageFloor: Math.floor(eff * ECLIPSE_STAGE_FLOOR),
  }
}

// 从当前激活 provider 现算（每次调用都读最新 config，/login 后自动用新模型的数）。
export function activeThresholds(): Thresholds {
  const eff = effectiveWindow(activeContextWindow(), activeMaxTokens())
  return thresholds(eff)
}

// 压缩后落点目标的绝对 token 数。
export function landingTarget(eff: number): number {
  return Math.floor(eff * LANDING_RATIO)
}

// UI 剩余百分比，相对 autocompact 阈值（设计文档 §4）。
export function percentLeft(used: number, autocompactThreshold: number): number {
  if (autocompactThreshold <= 0) return 0
  return Math.max(0, Math.round(((autocompactThreshold - used) / autocompactThreshold) * 100))
}
