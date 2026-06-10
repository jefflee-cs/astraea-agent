// Astraea cron daemon — 极轻量调度进程
// 职责：读取 ~/.astraea/scheduled_tasks.json，每秒 check，到点触发 headless agent
// 本体不调用 LLM；LLM 调用发生在 Bun.spawn 出的 headless 子进程中
//
// 启动方式（由 CronCreateTool 或 cli.ts --daemon 触发）：
//   bun run src/cli.ts --daemon

import { readTasks, writeTasks, getDaemonPidPath } from '../utils/vigilTasks.js'
import { calcNextFireAt } from './cron-scheduler.js'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TICK_MS = 1_000
const RESULT_DIR_VAR = 'ASTRAEA_TASK_RESULT_DIR'

// 单个 headless 任务的硬上限。超过即认定其卡死（典型：流式 API 调用在异常端点上
// 空转 100% CPU），强杀进程并写一条失败结果，避免任务静默地烧 CPU 永不返回。
const HEADLESS_TIMEOUT_MS = Number(process.env.ASTRAEA_HEADLESS_TIMEOUT_MS) || 4 * 60_000

function getResultDir(): string {
  const { homedir } = require('node:os')
  const dir = join(homedir(), '.astraea', 'task-results')
  require('node:fs').mkdirSync(dir, { recursive: true })
  return dir
}

async function fireTask(taskId: string, prompt: string, cwd?: string): Promise<void> {
  const resultDir = getResultDir()
  const resultFile = join(resultDir, `${taskId}.json`)
  const spawnCwd = cwd ?? process.cwd()

  console.log(`[vigil] Firing task ${taskId} (cwd=${spawnCwd}): ${prompt.slice(0, 60)}`)

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, '../cli.ts'), '--headless', '--task', taskId],
    {
      cwd: spawnCwd,
      env: {
        ...process.env,
        ASTRAEA_HEADLESS_PROMPT: prompt,
        ASTRAEA_HEADLESS_TASK_ID: taskId,
        [RESULT_DIR_VAR]: resultDir,
        ASTRAEA_RESULT_FILE: resultFile,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  // 持续抽干 stdout/stderr：否则子进程写满 ~64KB 管道缓冲后会阻塞；同时把日志留作
  // 失败结果的诊断尾巴。
  const stdoutP = new Response(proc.stdout).text().catch(() => '')
  const stderrP = new Response(proc.stderr).text().catch(() => '')

  // Watchdog：超过硬上限就认定卡死，SIGKILL 强杀（同步空转时 abort 信号无法打断，
  // 只有外部强杀这一条硬保证）。
  let timedOut = false
  const watchdog = setTimeout(() => {
    timedOut = true
    try { proc.kill('SIGKILL') } catch { /* already gone */ }
  }, HEADLESS_TIMEOUT_MS)

  const exitCode = await proc.exited
  clearTimeout(watchdog)
  const [stdout, stderr] = await Promise.all([stdoutP, stderrP])

  console.log(
    `[vigil] Task ${taskId} exited with code ${exitCode}` +
    (timedOut ? ` (killed by watchdog after ${Math.round(HEADLESS_TIMEOUT_MS / 1000)}s — timed out)` : ''),
  )

  // 干净跑完时 headless 子进程会自己写成功结果。只有在它超时/异常退出、且没留下任何
  // 结果文件时，才补写一条失败结果，让 REPL 能把失败浮现出来，而不是静默消失。
  if ((timedOut || exitCode !== 0) && !existsSync(resultFile)) {
    const reason = timedOut
      ? `Task timed out after ${Math.round(HEADLESS_TIMEOUT_MS / 1000)}s and was terminated — it was likely stuck on a hung model/stream call.`
      : `Task exited with code ${exitCode}.`
    const tail = (stderr || stdout || '').trim().slice(-1500)
    writeFileSync(resultFile, JSON.stringify({
      taskId,
      prompt,
      output: tail ? `${reason}\n\n--- last log output ---\n${tail}` : reason,
      completedAt: new Date().toISOString(),
      read: false,
      failed: true,
    }, null, 2), 'utf-8')
  }
}

export async function runDaemon(): Promise<void> {
  // 写 PID 文件
  writeFileSync(getDaemonPidPath(), String(process.pid), 'utf-8')
  console.log(`[vigil daemon] started (pid ${process.pid})`)

  process.on('exit', () => {
    try { unlinkSync(getDaemonPidPath()) } catch { /* ignore */ }
  })
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT',  () => process.exit(0))

  // 已触发但尚未结束的 headless 子进程。daemon 不能在它们还在跑时退出，否则会孤儿化
  // 子进程（并切断其管道 stdio），watchdog 也就再没机会强杀/写失败结果。
  const inFlight = new Set<Promise<void>>()

  while (true) {
    const tasks = readTasks()

    if (tasks.length === 0) {
      if (inFlight.size > 0) {
        // 任务已触发但子进程还在跑 —— 留守等它们落地，再决定是否退出。
        await Bun.sleep(TICK_MS)
        continue
      }
      console.log('[vigil daemon] no tasks remaining, exiting.')
      process.exit(0)
    }

    const now = Date.now()
    const updated = [...tasks]

    for (let i = 0; i < updated.length; i++) {
      const task = updated[i]!
      if (task.nextFireAt <= now) {
        // Fire — don't await (non-blocking)，但登记进 inFlight 以便守住其生命周期
        const p = fireTask(task.id, task.prompt, task.cwd).catch(err =>
          console.error(`[vigil] task ${task.id} error:`, err),
        )
        inFlight.add(p)
        void p.finally(() => inFlight.delete(p))

        if (task.recurring && task.cron) {
          updated[i] = {
            ...task,
            lastFiredAt: now,
            nextFireAt: calcNextFireAt(task.cron, now),
          }
        } else {
          // One-shot: remove after firing
          updated.splice(i, 1)
          i--
        }
      }
    }

    writeTasks(updated)
    await Bun.sleep(TICK_MS)
  }
}
