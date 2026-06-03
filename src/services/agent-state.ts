// AppState 单例 — 调度层的全局共享状态
// 所有工具通过此模块读写任务状态，setAppState 函数式更新保证并发安全

import crypto from 'crypto'

export type AgentStatus = 'running' | 'completed' | 'failed' | 'killed'
export type TaskRecordStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

const OUTPUT_RING_MAX = 1000

export interface AgentTaskState {
  id: string
  kind: 'agent'
  status: AgentStatus
  prompt: string
  description: string
  result?: string
  error?: string
  notified: boolean
  startedAt: Date
  endedAt?: Date
  abortController: AbortController
  outputBuffer: string[]
  pendingMessages: string[]
}

export interface TaskRecordState {
  id: string
  kind: 'task'
  subject: string
  description?: string
  status: TaskRecordStatus
  createdAt: Date
  updatedAt: Date
}

export type AnyTask = AgentTaskState | TaskRecordState

interface AppState {
  tasks: Record<string, AnyTask>
}

let _state: AppState = { tasks: {} }

export function getState(): Readonly<AppState> {
  return _state
}

export function setState(updater: (prev: AppState) => AppState): void {
  _state = updater(_state)
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function generateAgentId(): string {
  const bytes = crypto.randomBytes(8)
  let id = 'a'
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length]!
  return id
}

export function generateTaskId(): string {
  return 'task-' + crypto.randomUUID()
}

export function appendAgentOutput(agentId: string, line: string): void {
  setState(prev => {
    const task = prev.tasks[agentId]
    if (!task || task.kind !== 'agent') return prev
    const buf = [...task.outputBuffer, line]
    if (buf.length > OUTPUT_RING_MAX) buf.splice(0, buf.length - OUTPUT_RING_MAX)
    return { ...prev, tasks: { ...prev.tasks, [agentId]: { ...task, outputBuffer: buf } } }
  })
}

export function registerAgentTask(
  agentId: string,
  prompt: string,
  description: string,
): AgentTaskState {
  const task: AgentTaskState = {
    id: agentId,
    kind: 'agent',
    status: 'running',
    prompt,
    description,
    notified: false,
    startedAt: new Date(),
    abortController: new AbortController(),
    outputBuffer: [],
    pendingMessages: [],
  }
  setState(prev => ({ ...prev, tasks: { ...prev.tasks, [agentId]: task } }))
  return task
}

export function completeAgentTask(agentId: string, result: string): boolean {
  let shouldNotify = false
  setState(prev => {
    const task = prev.tasks[agentId]
    if (!task || task.kind !== 'agent' || task.status !== 'running' || task.notified) return prev
    shouldNotify = true
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [agentId]: { ...task, status: 'completed', result, notified: true, endedAt: new Date() },
      },
    }
  })
  return shouldNotify
}

export function failAgentTask(agentId: string, error: string): boolean {
  let shouldNotify = false
  setState(prev => {
    const task = prev.tasks[agentId]
    if (!task || task.kind !== 'agent' || task.status !== 'running' || task.notified) return prev
    shouldNotify = true
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [agentId]: { ...task, status: 'failed', error, notified: true, endedAt: new Date() },
      },
    }
  })
  return shouldNotify
}

export function killAgentTask(agentId: string): boolean {
  let didKill = false
  setState(prev => {
    const task = prev.tasks[agentId]
    if (!task || task.kind !== 'agent' || task.status !== 'running') return prev
    didKill = true
    task.abortController.abort()
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [agentId]: { ...task, status: 'killed', notified: true, endedAt: new Date() },
      },
    }
  })
  return didKill
}

// 清空整个调度状态 —— 供 /clear 使用，让新会话从零开始。
// 协作式取消所有仍在运行的子 Agent（abort 而非强杀），再丢弃整张任务字典。
// 返回被中止的运行中 agent 数量，便于 REPL 给用户回执。
export function clearAllTasks(): number {
  let aborted = 0
  for (const task of Object.values(_state.tasks)) {
    if (task.kind === 'agent' && task.status === 'running') {
      task.abortController.abort()
      aborted++
    }
  }
  _state = { tasks: {} }
  return aborted
}

export function drainPendingMessages(agentId: string): string[] {
  let messages: string[] = []
  setState(prev => {
    const task = prev.tasks[agentId]
    if (!task || task.kind !== 'agent') return prev
    messages = [...task.pendingMessages]
    return { ...prev, tasks: { ...prev.tasks, [agentId]: { ...task, pendingMessages: [] } } }
  })
  return messages
}

export function pushPendingMessage(agentId: string, message: string): boolean {
  let found = false
  setState(prev => {
    const task = prev.tasks[agentId]
    if (!task || task.kind !== 'agent' || task.status !== 'running') return prev
    found = true
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [agentId]: { ...task, pendingMessages: [...task.pendingMessages, message] },
      },
    }
  })
  return found
}

export function hasRunningAgents(): boolean {
  return Object.values(_state.tasks).some(t => t.kind === 'agent' && t.status === 'running')
}
