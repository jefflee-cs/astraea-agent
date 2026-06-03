// 核心消息类型 — 对齐 Anthropic API 格式
// 参考源码: claude-code-main/src/types/message.ts

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'

// ───────────────────────────────── 基础块类型 ─────────────────────────────────

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | TextBlock[]
  is_error?: boolean
}

// ───────────────────────────────── 消息类型 ──────────────────────────────────

// 用户消息（内部表示）
export interface UserMessage {
  role: 'user'
  content: string | (TextBlock | ToolResultBlock)[]
}

// 助手消息（内部表示）
export interface AssistantMessage {
  role: 'assistant'
  content: (TextBlock | ToolUseBlock)[]
}

export type Message = UserMessage | AssistantMessage

// ───────────────────────────────── 流式事件 ──────────────────────────────────

// 模型停止本轮输出的原因。'max_tokens' 表示撞到输出上限被截断（产物可能不完整）。
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'other'

// 我们自己的流事件，比 SDK 原始事件更精简
export type StreamEvent =
  | { type: 'text'; text: string }
  // incomplete: 工具入参 JSON 在累积过程中被截断、parse 失败 —— 不可执行，需让模型重试
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; incomplete?: boolean }
  | { type: 'message_stop'; usage: { input_tokens: number; output_tokens: number }; stopReason?: StopReason }

// ───────────────────────────────── 工具函数 ──────────────────────────────────

// 把内部 Message 转成 Anthropic API 需要的 MessageParam 格式
export function toAPIMessage(msg: Message): MessageParam {
  if (msg.role === 'user') {
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content }
    }
    return {
      role: 'user',
      content: msg.content.map((block) => {
        if (block.type === 'tool_result') {
          return {
            type: 'tool_result' as const,
            tool_use_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : block.content,
            is_error: block.is_error,
          }
        }
        return block
      }),
    }
  }

  // assistant
  return {
    role: 'assistant',
    content: msg.content,
  }
}

export function createUserMessage(text: string): UserMessage {
  return { role: 'user', content: text }
}

export function createAssistantMessage(content: (TextBlock | ToolUseBlock)[]): AssistantMessage {
  return { role: 'assistant', content }
}
