// 插队队列 — 用户在 Astraea 执行中途输入的指令，于轮间被 query.ts 拾取注入下一轮上下文。
// 与 notification-queue 同构但语义独立：那条队列是后台子 Agent 的结果回灌，这条是「用户说话」。
// 分开存放的理由：① 模型需区分「用户插话」与「工具回报」；② ESC/停止时只清插队、保留未消费的任务通知。

const _queue: string[] = []

export function enqueueInterject(text: string): void {
  const t = text.trim()
  if (t) _queue.push(t)
}

export function drainInterjects(): string[] {
  return _queue.splice(0, _queue.length)
}

export function hasPendingInterjects(): boolean {
  return _queue.length > 0
}

// ESC / /stop / /clear：丢弃尚未拾取的插队。返回被清掉的条数，供 REPL 回执。
export function clearInterjects(): number {
  const n = _queue.length
  _queue.length = 0
  return n
}
