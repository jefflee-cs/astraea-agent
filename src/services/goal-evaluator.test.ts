import { test, expect } from 'bun:test'
import { parseDecision, serializeTranscript } from './goal-evaluator'
import type { AssistantMessage, UserMessage } from '../types/message'

// ── parseDecision ────────────────────────────────────────────────────────────

test('parses a clean JSON verdict', () => {
  const d = parseDecision('{"met": true, "reason": "tests passed"}')
  expect(d.met).toBe(true)
  expect(d.reason).toBe('tests passed')
})

test('parses JSON wrapped in code fences and prose', () => {
  const raw = 'Here is my verdict:\n```json\n{"met": false, "reason": "still 2 failures"}\n```'
  const d = parseDecision(raw)
  expect(d.met).toBe(false)
  expect(d.reason).toBe('still 2 failures')
})

test('supplies a default reason when reason is missing', () => {
  const d = parseDecision('{"met": true}')
  expect(d.met).toBe(true)
  expect(d.reason.length).toBeGreaterThan(0)
})

test('falls back conservatively to not-met on unparseable output', () => {
  const d = parseDecision('the model rambled without any json')
  expect(d.met).toBe(false)
  expect(d.reason).toContain('non-JSON')
})

test('heuristic detects an affirmative non-JSON answer', () => {
  const d = parseDecision('Yes, the condition is satisfied.')
  expect(d.met).toBe(true)
})

test('heuristic treats "not satisfied" as not met', () => {
  const d = parseDecision('No, this is not satisfied yet.')
  expect(d.met).toBe(false)
})

// ── serializeTranscript ──────────────────────────────────────────────────────

test('serializes user text, assistant text, tool calls and tool results', () => {
  const messages: (UserMessage | AssistantMessage)[] = [
    { role: 'user', content: 'run the tests' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Running tests now' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'All tests passed, exit 0' }],
    },
  ]
  const out = serializeTranscript(messages)
  expect(out).toContain('USER: run the tests')
  expect(out).toContain('ASSISTANT: Running tests now')
  expect(out).toContain('ASSISTANT_TOOL_CALL: Bash')
  expect(out).toContain('TOOL_RESULT: All tests passed, exit 0')
})

test('marks error tool results distinctly', () => {
  const messages: (UserMessage | AssistantMessage)[] = [
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
    },
  ]
  expect(serializeTranscript(messages)).toContain('TOOL_RESULT(error): boom')
})

test('truncates very long transcripts but keeps the tail', () => {
  const big = 'A'.repeat(40_000)
  const messages: (UserMessage | AssistantMessage)[] = [
    { role: 'user', content: big },
    { role: 'assistant', content: [{ type: 'text', text: 'FINAL_MARKER' }] },
  ]
  const out = serializeTranscript(messages)
  expect(out.length).toBeLessThan(20_000)
  expect(out).toContain('FINAL_MARKER')
  expect(out).toContain('truncated')
})
