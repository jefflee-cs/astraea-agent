// Microcompact 的时间戳单例 —— 进程级，与 contextTokens.ts 同构（上下文机制设计 §3.3）。
//
// time-based microcompact 触发要算 (now − 最后一条 assistant 消息时间)。内存里的
// AssistantMessage 只有 {role, content}、无时间戳，所以这里单独存一份"最后一条 assistant
// 的时间"，不污染消息类型 / toAPIMessage / transcript 序列化。
//
// 只追踪主对话（query() 里 compactionEnabled === true）；子 agent 不写它，天然无污染。

// 最后一条主对话 assistant 消息的时间（Date.now() 毫秒）。null = 尚无前置 assistant
// （首轮，或刚 /resume 未回填）。
let lastAssistantTs: number | null = null

/** query() 每次 message_stop 调用（仅主对话）：记录这一刻为"最后一条 assistant 时间"。 */
export function recordAssistantTs(): void {
  lastAssistantTs = Date.now()
}

/** 触发判定时读取；null 时调用方应 no-op（无前置 assistant）。 */
export function getLastAssistantTs(): number | null {
  return lastAssistantTs
}

/** /resume：从 transcript 最后一条 assistant 行的 timestamp 回填，让恢复后第一轮也能正确算 gap。 */
export function setLastAssistantTs(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) lastAssistantTs = ms
}

/** /clear：随新会话清零。 */
export function resetMicrocompactState(): void {
  lastAssistantTs = null
}
