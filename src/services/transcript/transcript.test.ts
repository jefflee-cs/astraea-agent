import { test, expect, afterEach } from 'bun:test'
import { rmSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import {
  escapeCwd,
  createTranscript,
  reopenTranscript,
  listSessions,
  loadSessionMessages,
  loadLatestSession,
  projectDir,
} from './transcript'
import { cleanupOldTranscripts } from './housekeeping'
import type { UserMessage, AssistantMessage } from '../../types/message'

const TEST_CWD = '/tmp/astraea-transcript-test-fixed'
afterEach(() => { try { rmSync(projectDir(TEST_CWD), { recursive: true, force: true }) } catch {} })

const U = (s: string): UserMessage => ({ role: 'user', content: s })
const A = (s: string): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text: s }] })

test('escapeCwd: /→-（同记忆目录方案）', () => {
  expect(escapeCwd('/Users/x/y')).toBe('-Users-x-y')
})

test('write + list + 无 compact 时全量恢复', () => {
  const w = createTranscript(TEST_CWD)
  expect(w.enabled).toBe(true)
  w.appendMessages([U('hello'), A('hi')])
  const sessions = listSessions(TEST_CWD)
  expect(sessions.length).toBe(1)
  expect(sessions[0]!.firstUserText).toBe('hello')
  const msgs = loadSessionMessages(sessions[0]!.path)
  expect(msgs.length).toBe(2)
  expect(msgs[0]!.role).toBe('user')
})

test('有 compact 标记 → 恢复 = 快照 + 标记之后的消息', () => {
  const w = createTranscript(TEST_CWD)
  w.appendMessages([U('m1'), A('a1'), U('m2'), A('a2')])
  // 压缩：快照 = [summary, recent]
  w.appendCompact([U('<conversation_summary>S</conversation_summary>'), A('a2')], 'S', 9000, 'auto')
  w.appendMessages([U('m3'), A('a3')])
  const restored = loadSessionMessages(listSessions(TEST_CWD)[0]!.path)
  // 快照 2 条 + 标记后 2 条 = 4；恢复到压缩态（不含 m1/a1/m2 的独立行）
  expect(restored.length).toBe(4)
  expect(JSON.stringify(restored[0]!.content)).toContain('conversation_summary')
  expect((restored[3] as AssistantMessage).content[0]).toMatchObject({ text: 'a3' })
})

test('reopenTranscript 续写同一文件', () => {
  const w = createTranscript(TEST_CWD)
  w.appendMessages([U('first')])
  const sid = w.sessionId
  const w2 = reopenTranscript(TEST_CWD, sid)
  expect(w2.enabled).toBe(true)
  expect(w2.sessionId).toBe(sid)
  w2.appendMessages([A('continued')])
  const sessions = listSessions(TEST_CWD)
  expect(sessions.length).toBe(1) // 同一文件，没新建
  expect(loadSessionMessages(sessions[0]!.path).length).toBe(2)
})

test('loadLatestSession 取最近', () => {
  const w = createTranscript(TEST_CWD)
  w.appendMessages([U('only')])
  const latest = loadLatestSession(TEST_CWD)
  expect(latest).not.toBeNull()
  expect(latest!.messages.length).toBe(1)
})

test('cleanupOldTranscripts：超期文件删、新文件留', () => {
  const w = createTranscript(TEST_CWD)
  w.appendMessages([U('recent')])
  const recentPath = listSessions(TEST_CWD)[0]!.path

  // 再造一个"旧"会话文件，把 mtime 调到 40 天前
  const w2 = createTranscript(TEST_CWD)
  w2.appendMessages([U('old')])
  const oldPath = w2.path
  const old = (Date.now() - 40 * 86_400_000) / 1000
  utimesSync(oldPath, old, old)

  const deleted = cleanupOldTranscripts() // 默认保留 30 天
  expect(deleted).toBe(1)
  expect(existsSync(oldPath)).toBe(false)
  expect(existsSync(recentPath)).toBe(true)
})
