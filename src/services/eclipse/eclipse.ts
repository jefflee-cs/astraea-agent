// Eclipse 编排层 —— 把 store + ctx-agent + 阈值串成主流程能调的几个动作（设计文档 Context Collapse）。
//
// 五个动作，对应 query.ts 流水线的五个挂点：
//   eclipseActive()    → 折叠开启时压制主动 autocompact
//   maybeSpawn()       → message_stop 后，token 增量+起步闸触发后台 ctx-agent（fire-and-forget）
//   commitIfNeeded()   → 发请求前到 0.85：吃 staged 存货、低 risk 先折（非阻塞，无模型调用）
//   blockingIfNeeded() → 到 0.95：存货不够，当场同步现折，主线程必须等
//   drainOnOverflow()  → API 返回 413：排空全部 staged 折叠，腾空间重试

import { config } from '../../config'
import { activeContextWindow, activeMaxTokens } from '../../config'
import { getInputTokens } from '../../state/contextTokens'
import { activeThresholds, effectiveWindow } from '../compact/window'
import { ECLIPSE_SPAWN_DELTA } from '../compact/window'
import { estimateTokens } from '../compact/compact'
import { proposeCollapses } from './ctxAgent'
import {
  type ConvMessage,
  type CommittedCollapse,
  projectView,
  getStaged,
  setStaged,
  commitStaged,
  isArmed,
  setArmed,
  getLastSpawnTokens,
  setLastSpawnTokens,
} from './store'

export { resetEclipse } from './store'

/** 折叠是否开启（用于压制主动 autocompact）。 */
export function eclipseActive(): boolean {
  return config.eclipse
}

/** 发给模型前的瘦身视图；关闭时原样返回。 */
export function projectForSend(messages: ConvMessage[]): ConvMessage[] {
  if (!config.eclipse) return messages
  return projectView(messages)
}

function currentEff(): number {
  return effectiveWindow(activeContextWindow(), activeMaxTokens())
}

/** 投影后的估算占用（含固定开销）。 */
function projectedTokens(messages: ConvMessage[], fixedOverhead: number): number {
  return estimateTokens(projectView(messages)) + fixedOverhead
}

// ── 后台 spawn：token 增量 + 起步闸，turn 驱动（fire-and-forget）──────────────
let inFlight = false // 防止上一次后台评估还没回来又起一个

export function maybeSpawn(messages: ConvMessage[], signal?: AbortSignal): void {
  if (!config.eclipse || inFlight) return
  const used = getInputTokens()
  if (used === null) return
  const th = activeThresholds()

  // 起步闸：到 0.75×eff 才武装。
  if (!isArmed()) {
    if (used >= th.eclipseStageFloor) setArmed(true)
    else return
  }
  // 增量门：距上次 spawn 又涨了 ECLIPSE_SPAWN_DELTA×eff 才再 spawn。
  const delta = Math.floor(currentEff() * ECLIPSE_SPAWN_DELTA)
  if (used - getLastSpawnTokens() < delta && getLastSpawnTokens() !== 0) return

  inFlight = true
  setLastSpawnTokens(used)
  // 不 await：后台评估，完成后整体替换 staged（last-wins）。
  void proposeCollapses(messages, currentEff(), signal)
    .then(staged => { if (staged.length > 0) setStaged(staged) })
    .catch(() => {})
    .finally(() => { inFlight = false })
}

// ── 0.85 提交：吃 staged 存货，低 risk 先折，吞到降回 commit 线下即停 ───────────
/** 返回本次新提交的折叠（供 transcript 落盘）；未提交返回空数组。 */
export function commitIfNeeded(messages: ConvMessage[], fixedOverhead: number): CommittedCollapse[] {
  if (!config.eclipse) return []
  const used = getInputTokens()
  if (used === null) return []
  const th = activeThresholds()
  if (used < th.eclipseCommit) return []

  const out: CommittedCollapse[] = []
  const sorted = [...getStaged()].sort((a, b) => a.risk - b.risk) // 低 risk 先折
  for (const s of sorted) {
    if (projectedTokens(messages, fixedOverhead) < th.eclipseCommit) break // 已降到线下，停（不过度折）
    out.push(commitStaged(s))
  }
  return out
}

// ── 0.95 阻塞：存货不够，当场同步现折，主线程必须等 ─────────────────────────────
export async function blockingIfNeeded(
  messages: ConvMessage[],
  fixedOverhead: number,
  signal?: AbortSignal,
): Promise<CommittedCollapse[]> {
  if (!config.eclipse) return []
  const used = getInputTokens()
  if (used === null) return []
  const th = activeThresholds()
  if (used < th.eclipseBlocking) return []
  if (projectedTokens(messages, fixedOverhead) < th.eclipseBlocking) return []

  // 当场现折：同步等 ctx-agent 评估，setStaged，再提交（一直折到降回 blocking 线下）。
  const fresh = await proposeCollapses(messages, currentEff(), signal)
  if (fresh.length > 0) setStaged(fresh)

  const out: CommittedCollapse[] = []
  const sorted = [...getStaged()].sort((a, b) => a.risk - b.risk)
  for (const s of sorted) {
    if (projectedTokens(messages, fixedOverhead) < th.eclipseBlocking) break
    out.push(commitStaged(s))
  }
  return out
}

// ── 413 急救：排空全部 staged（不管阈值），腾空间重试 ───────────────────────────
export function drainOnOverflow(): CommittedCollapse[] {
  if (!config.eclipse) return []
  const out: CommittedCollapse[] = []
  for (const s of [...getStaged()]) out.push(commitStaged(s))
  return out
}
