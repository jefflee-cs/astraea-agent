import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  beginCheckpoint,
  captureFile,
  listCheckpoints,
  getCheckpoint,
  applyRestore,
  resetCheckpoints,
} from './checkpointStore'

let dir: string
beforeEach(() => { resetCheckpoints(); dir = mkdtempSync(join(tmpdir(), 'rewind-')) })
afterEach(() => { resetCheckpoints(); rmSync(dir, { recursive: true, force: true }) })

test('checkpoints track turn + convLen, newest first', () => {
  beginCheckpoint({ convLen: 0, userText: 'first' })
  beginCheckpoint({ convLen: 2, userText: 'second' })
  const cps = listCheckpoints()
  expect(cps.map(c => c.turn)).toEqual([2, 1])
  expect(getCheckpoint(1)!.convLen).toBe(0)
  expect(getCheckpoint(2)!.convLen).toBe(2)
})

test('restore reverts edited file to its earliest pre-state in the window', () => {
  const f = join(dir, 'a.txt')
  writeFileSync(f, 'v0')

  // turn 1 edits f: v0 -> v1
  beginCheckpoint({ convLen: 0, userText: 't1' })
  captureFile(f); writeFileSync(f, 'v1')
  // turn 2 edits f again: v1 -> v2
  beginCheckpoint({ convLen: 2, userText: 't2' })
  captureFile(f); writeFileSync(f, 'v2')

  const res = applyRestore(1)!
  // MIN-turn preContent across turns>=1 is turn1's "v0"
  expect(res.convLen).toBe(0)
  expect(readFileSync(f, 'utf8')).toBe('v0')
  expect(res.restored).toContain(f)
})

test('captureFile is idempotent within a turn (keeps first pre-state)', () => {
  const f = join(dir, 'b.txt')
  writeFileSync(f, 'orig')
  beginCheckpoint({ convLen: 0, userText: 't1' })
  captureFile(f); writeFileSync(f, 'mid')
  captureFile(f); writeFileSync(f, 'final') // second capture ignored
  applyRestore(1)
  expect(readFileSync(f, 'utf8')).toBe('orig')
})

test('file created during a turn is deleted on rewind (null pre-state)', () => {
  const f = join(dir, 'new.txt')
  beginCheckpoint({ convLen: 4, userText: 't1' })
  captureFile(f) // file does not exist yet -> preContent null
  writeFileSync(f, 'created')
  const res = applyRestore(1)!
  expect(existsSync(f)).toBe(false)
  expect(res.deleted).toContain(f)
})

test('applyRestore drops checkpoints >= turn and rewinds the turn counter', () => {
  beginCheckpoint({ convLen: 0, userText: 't1' })
  beginCheckpoint({ convLen: 2, userText: 't2' })
  beginCheckpoint({ convLen: 4, userText: 't3' })
  applyRestore(2)
  expect(listCheckpoints().map(c => c.turn)).toEqual([1])
  // next turn should reuse turn number 2 (counter rolled back to 1)
  const next = beginCheckpoint({ convLen: 2, userText: 't2-redo' })
  expect(next).toBe(2)
})

test('unknown checkpoint returns null', () => {
  beginCheckpoint({ convLen: 0, userText: 't1' })
  expect(applyRestore(99)).toBeNull()
})
