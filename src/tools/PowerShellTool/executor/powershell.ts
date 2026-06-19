import { getCurrentCwd } from '../../BashTool/executor/cwd-tracker.js'

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_STDERR_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

export interface PsInput {
  command: string
  timeout?: number
  description?: string
}

export interface PsOutput {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

let cachedPwsh: string | null | undefined

async function findPwsh(): Promise<string | null> {
  if (cachedPwsh !== undefined) return cachedPwsh
  // prefer pwsh (PowerShell 7+, cross-platform), fall back to powershell (Windows built-in).
  // Probe the binary directly rather than via `which`/`where` — `which` doesn't exist on
  // Windows and `where` doesn't exist on Unix, so resolver names aren't portable.
  for (const bin of ['pwsh', 'powershell']) {
    try {
      const proc = Bun.spawn([bin, '-NoProfile', '-Command', '$null'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await proc.exited
      if (proc.exitCode === 0) {
        cachedPwsh = bin
        return bin
      }
    } catch {
      // ENOENT: binary not on PATH — try the next candidate
    }
  }
  cachedPwsh = null
  return null
}

export async function executePowerShell(input: PsInput): Promise<PsOutput> {
  const pwsh = await findPwsh()
  if (!pwsh) {
    return {
      stdout: '',
      stderr: 'PowerShell (pwsh) is not installed. Install it from https://github.com/PowerShell/PowerShell',
      exitCode: 127,
      timedOut: false,
    }
  }

  const timeoutMs = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const cwd = getCurrentCwd()

  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)

  let timedOut = false

  try {
    const proc = Bun.spawn(
      [pwsh, '-NonInteractive', '-NoProfile', '-Command', input.command],
      {
        cwd,
        env: { ...(process.env as Record<string, string>), ASTRAEA: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    const abortHandler = () => proc.kill()
    timeoutController.signal.addEventListener('abort', abortHandler, { once: true })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    await proc.exited
    timeoutController.signal.removeEventListener('abort', abortHandler)
    clearTimeout(timer)

    return {
      stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
      stderr: stderr.slice(0, MAX_STDERR_BYTES),
      exitCode: proc.exitCode ?? 0,
      timedOut: false,
    }
  } catch (err) {
    clearTimeout(timer)
    if (timeoutController.signal.aborted) timedOut = true
    return {
      stdout: '',
      stderr: timedOut ? `Command timed out after ${timeoutMs}ms` : String(err),
      exitCode: -1,
      timedOut,
    }
  }
}
