// 会话引导（Session Preamble）
// 参考：01-会话引导-Session-Preamble.md · Step 3 MVA
//
// ARCHITECTURAL INTENT:
// Session preamble gathers per-session facts (git state, repo rules, date)
// and injects them into each turn's context. "Compute once per session,
// inject many times per turn" — achieved via Promise-level memoization.
// All context is scoped to cwd to prevent cross-project contamination.

import { memoize } from '../utils/memoize'
import type { AssistantMessage, UserMessage } from '../types/message'

// Hard upper bound prevents monorepo exhaustion (500k commits → megabytes).
const MAX_GIT_STATUS_CHARS = 2000

// ─── Types ────────────────────────────────────────────────────────────────────

export type SystemContext = {
  gitStatus?: string
}

export type UserContext = {
  claudeMd: string
  currentDate: string
}

// ─── System Context ───────────────────────────────────────────────────────────

// Memoized at Promise level: concurrent callers share the same pending Promise,
// so git is never read twice even if two turns start simultaneously.
export const getSystemContext = memoize(async (): Promise<SystemContext> => {
  const gitStatus = await safeGetGitStatus()
  return { gitStatus }
})

async function safeGetGitStatus(): Promise<string | undefined> {
  try {
    const raw = await readGitState()
    return raw.length > MAX_GIT_STATUS_CHARS
      ? raw.slice(0, MAX_GIT_STATUS_CHARS) + '\n[...truncated]'
      : raw
  } catch {
    // git not installed, not a repo, or permission denied — degrade gracefully.
    return undefined
  }
}

async function readGitState(): Promise<string> {
  const branch = await Bun.$`git rev-parse --abbrev-ref HEAD`.quiet().text()
  const status = await Bun.$`git status --short`.quiet().text()
  const log = await Bun.$`git log --oneline -3 --no-pager`.quiet().text()

  return [
    `Branch: ${branch.trim()}`,
    status.trim() ? `Changes:\n${status.trim()}` : 'Working tree clean',
    `Recent commits:\n${log.trim()}`,
  ].join('\n')
}

// ─── User Context ─────────────────────────────────────────────────────────────

// Scoped by cwd: different projects get different user contexts.
export const getUserContext = memoize(async (cwd: string): Promise<UserContext> => {
  const currentDate = new Date().toISOString().split('T')[0] ?? new Date().toISOString()
  const claudeMd = await loadAgentsMd(cwd)
  return { claudeMd, currentDate }
})

// Astraea 的项目级指令文件是 AGENTS.md / AGENTS.local.md（定稿 #24），不是 CLAUDE.md。
// 顺序：项目级 AGENTS.md（进 git）→ 个人级 AGENTS.local.md（不进 git）→ 全局 ~/.astraea/AGENTS.md。
// /remember 把 auto-memory 提升到前两层后，必须由这里读出才生效（连带前置 #1）。
async function loadAgentsMd(cwd: string): Promise<string> {
  const home = process.env.HOME ?? ''
  const paths = [
    `${cwd}/AGENTS.md`,
    `${cwd}/AGENTS.local.md`,
    home ? `${home}/.astraea/AGENTS.md` : '',
  ].filter(Boolean)
  const parts: string[] = []
  for (const p of paths) {
    try {
      const file = Bun.file(p)
      if (await file.exists()) {
        parts.push(await file.text())
      }
    } catch {
      // Missing or unreadable — skip silently.
    }
  }
  return parts.join('\n\n').trim()
}

// ─── Injection Helpers ────────────────────────────────────────────────────────

// Appends git state to the system prompt string.
export function appendSystemContext(systemPrompt: string, context: SystemContext): string {
  if (!context.gitStatus) return systemPrompt
  return `${systemPrompt}\n\n# Current Git Status\n${context.gitStatus}`
}

// Prepends claudeMd + date as a <system-reminder> user message at position 0.
// Placement at the start maximizes recency salience for the first assistant turn.
export function prependUserContext(
  messages: (UserMessage | AssistantMessage)[],
  context: UserContext,
): (UserMessage | AssistantMessage)[] {
  const parts: string[] = []

  if (context.claudeMd) {
    parts.push(`<system-reminder>\n${context.claudeMd}\n</system-reminder>`)
  }

  parts.push(`<system-reminder>\nToday's date is ${context.currentDate}.\n</system-reminder>`)

  const reminderBlock: UserMessage = {
    role: 'user',
    content: parts.join('\n\n'),
  }

  return [reminderBlock, ...messages]
}
