// Phoenix 可观测性桥接（路线 B：手工 span + 句柄穿线 + 脱敏）—— 统一出口。
// 对标 claude-code: src/services/langfuse/index.ts
//
// 用法见 query.ts 接线点 + /Bridge/可观测性桥接-通俗讲解.md
export { initPhoenix, shutdownPhoenix, isPhoenixEnabled, isPhoenixActive } from './client'
export { createTrace, recordLLMObservation, recordToolObservation, createChildSpan, endTrace } from './tracing'
export type { PhoenixTrace } from './tracing'
export { sanitizeToolInput, sanitizeToolOutput, sanitizeGlobal } from './sanitize'
