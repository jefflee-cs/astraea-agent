// Transcript housekeeping（设计文档 §10）。
//
// 默认保留 30 天；cleanupPeriodDays 三档（>0 保留天数 / 0 关闭持久化 / <0 永久保留）。
// 删除单位 = 整个 session 文件（mtime 超期则删）。触发：启动 +10min + 之后每天一次。
// marker（上次清理时间戳）限流到约每天一次；lock 防多个并发 Astraea 实例同时清。

import { join } from 'node:path'
import {
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { cleanupPeriodDays, projectsRoot } from './transcript'

const DAY_MS = 86_400_000
const MARKER = () => join(projectsRoot(), '.last-cleanup')
const LOCK = () => join(projectsRoot(), '.cleanup-lock')
const LOCK_STALE_MS = 60 * 60 * 1000 // 1h 视为僵尸锁

/** 删除所有 project 下超期的 session .jsonl。days<=0 跳过（0 关闭 / <0 永久保留）。 */
export function cleanupOldTranscripts(now = Date.now()): number {
  const days = cleanupPeriodDays()
  if (days <= 0) return 0
  const root = projectsRoot()
  if (!existsSync(root)) return 0
  const cutoff = now - days * DAY_MS
  let deleted = 0
  for (const proj of safeReaddir(root)) {
    const dir = join(root, proj)
    let isDir = false
    try { isDir = statSync(dir).isDirectory() } catch { continue }
    if (!isDir) continue
    for (const f of safeReaddir(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const fp = join(dir, f)
      try {
        if (statSync(fp).mtimeMs < cutoff) { unlinkSync(fp); deleted++ }
      } catch { /* 跳过 */ }
    }
  }
  return deleted
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

function ranRecently(now: number): boolean {
  try {
    const ts = Number(readFileSync(MARKER(), 'utf-8').trim())
    return Number.isFinite(ts) && now - ts < 20 * 60 * 60 * 1000 // 20h ≈ 每天一次
  } catch {
    return false
  }
}

// 简易文件锁：写入失败/已存在且新鲜 → 别人正在清，跳过；僵尸锁则夺取。
function acquireLock(now: number): boolean {
  const lock = LOCK()
  try {
    if (existsSync(lock)) {
      const age = now - statSync(lock).mtimeMs
      if (age < LOCK_STALE_MS) return false // 别人正在清
      try { rmSync(lock) } catch { /* 夺取僵尸锁 */ }
    }
    writeFileSync(lock, String(process.pid), { flag: 'wx' }) // wx：已存在则抛
    return true
  } catch {
    return false // 竞争失败
  }
}

function releaseLock(): void {
  try { rmSync(LOCK()) } catch { /* already gone */ }
}

/** 限流执行清理：约每天一次 + 防并发。持久化关闭（days===0）时不跑。 */
export function maybeRunCleanup(now = Date.now()): void {
  if (cleanupPeriodDays() === 0) return
  if (ranRecently(now)) return
  if (!acquireLock(now)) return
  try {
    cleanupOldTranscripts(now)
    try { writeFileSync(MARKER(), String(now)) } catch { /* 忽略 */ }
  } finally {
    releaseLock()
  }
}

/** 启动调度：+10min 趁空闲跑一次，之后每天一次。timer unref 不阻止进程退出。 */
export function scheduleHousekeeping(): void {
  if (cleanupPeriodDays() === 0) return
  const first = setTimeout(() => maybeRunCleanup(), 10 * 60 * 1000)
  const daily = setInterval(() => maybeRunCleanup(), DAY_MS)
  first.unref?.()
  daily.unref?.()
}
