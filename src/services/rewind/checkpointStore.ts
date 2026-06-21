// Checkpoint store —— /rewind 的会话内时间倒流单例（设计见记忆 rewind-command-design）。
//
// 两个维度：
//   · 对话回滚：每个用户回合开始前记一个 checkpoint（convLen = 当时 conversationRef 长度）。
//   · 文件回滚：copy-on-write。Write/Edit 工具写盘前调 captureFile()，按「回合窗口」存一份
//     改动前快照（同一文件同一回合只存第一份）。回滚到第 K 回合 = 取 turn>=K 的所有快照，
//     按文件分组，写回各文件 MIN-turn 的 preContent（preContent===null ⇒ 删除文件）。
//
// v1 局限：只覆盖 Write/Edit。Bash 的 rm/mv/重定向不在捕获范围（需 shadow-git，P3）。

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Checkpoint {
  /** 1-based 回合号，每个用户回合自增。 */
  turn: number
  /** 该回合用户消息追加「之前」的 conversationRef 长度——回滚即截到此长度。 */
  convLen: number
  /** 该回合用户消息的预览文本（picker 展示用）。 */
  userText: string
  /** 创建时刻（毫秒）。 */
  createdAt: number
}

interface FileSnapshot {
  /** 发生写入的回合号。 */
  turn: number
  filePath: string
  /** 写入「之前」的文件内容；null = 当时文件不存在（回滚 ⇒ 删除）。 */
  preContent: string | null
}

let currentTurn = 0
let checkpoints: Checkpoint[] = []
let snapshots: FileSnapshot[] = []
// 去重：同一文件同一回合只存第一份改动前快照。键 = `${turn}:${filePath}`。
const capturedThisTurn = new Set<string>()

/** 开一个新回合检查点；返回回合号。在 runConversation 追加用户消息前调用。 */
export function beginCheckpoint(opts: { convLen: number; userText: string }): number {
  currentTurn += 1
  checkpoints.push({
    turn: currentTurn,
    convLen: opts.convLen,
    userText: opts.userText.slice(0, 200),
    createdAt: Date.now(),
  })
  return currentTurn
}

/** Write/Edit 写盘前调用：记录该文件本回合改动前的快照（同文件同回合幂等）。 */
export function captureFile(filePath: string): void {
  if (currentTurn === 0) return // 尚无活动回合（启动早期）→ 不捕获
  const key = `${currentTurn}:${filePath}`
  if (capturedThisTurn.has(key)) return
  capturedThisTurn.add(key)
  let preContent: string | null = null
  try {
    preContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null
  } catch {
    preContent = null // 读不动就当不存在；回滚时按删除处理
  }
  snapshots.push({ turn: currentTurn, filePath, preContent })
}

/** 列出可回滚的检查点（最新在前），供 picker 展示。 */
export function listCheckpoints(): Checkpoint[] {
  return [...checkpoints].reverse()
}

export function getCheckpoint(turn: number): Checkpoint | undefined {
  return checkpoints.find(c => c.turn === turn)
}

export interface RestoreResult {
  /** conversationRef 应截到的长度。 */
  convLen: number
  /** 已写回原内容的文件路径。 */
  restored: string[]
  /** 已删除（回滚到「不存在」态）的文件路径。 */
  deleted: string[]
}

/**
 * 回滚到第 turn 回合「之前」：还原文件 + 丢弃 >= turn 的检查点与快照，currentTurn 回退。
 * 不动 conversationRef / transcript / UI——那些由调用方按返回的 convLen 处理。
 */
export function applyRestore(turn: number): RestoreResult | null {
  const cp = getCheckpoint(turn)
  if (!cp) return null

  // turn>=K 的快照按文件分组，取 MIN-turn 的 preContent（窗口内最早的改动前态）。
  const earliest = new Map<string, FileSnapshot>()
  for (const s of snapshots) {
    if (s.turn < turn) continue
    const prev = earliest.get(s.filePath)
    if (!prev || s.turn < prev.turn) earliest.set(s.filePath, s)
  }

  const restored: string[] = []
  const deleted: string[] = []
  for (const s of earliest.values()) {
    try {
      if (s.preContent === null) {
        if (existsSync(s.filePath)) { rmSync(s.filePath); deleted.push(s.filePath) }
      } else {
        mkdirSync(dirname(s.filePath), { recursive: true })
        writeFileSync(s.filePath, s.preContent, 'utf8')
        restored.push(s.filePath)
      }
    } catch {
      // 单个文件还原失败不阻断其余（best-effort）
    }
  }

  // 丢弃被回滚掉的检查点与快照，回合计数退回到 turn-1。
  checkpoints = checkpoints.filter(c => c.turn < turn)
  snapshots = snapshots.filter(s => s.turn < turn)
  for (const key of [...capturedThisTurn]) {
    const t = Number(key.slice(0, key.indexOf(':')))
    if (t >= turn) capturedThisTurn.delete(key)
  }
  currentTurn = turn - 1

  return { convLen: cp.convLen, restored, deleted }
}

/** 清空所有检查点与快照（/clear、/resume、切换会话时调用）。 */
export function resetCheckpoints(): void {
  currentTurn = 0
  checkpoints = []
  snapshots = []
  capturedThisTurn.clear()
}
