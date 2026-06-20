import { test, expect, beforeEach } from 'bun:test'
import {
  enqueueInterject,
  drainInterjects,
  hasPendingInterjects,
  clearInterjects,
} from './interject-queue'

beforeEach(() => {
  clearInterjects()
})

test('enqueue then drain returns FIFO order and empties the queue', () => {
  enqueueInterject('first')
  enqueueInterject('second')
  expect(hasPendingInterjects()).toBe(true)
  expect(drainInterjects()).toEqual(['first', 'second'])
  expect(hasPendingInterjects()).toBe(false)
  expect(drainInterjects()).toEqual([])
})

test('blank / whitespace-only interjects are ignored', () => {
  enqueueInterject('   ')
  enqueueInterject('')
  expect(hasPendingInterjects()).toBe(false)
})

test('enqueue trims surrounding whitespace', () => {
  enqueueInterject('  stop, wrong file  ')
  expect(drainInterjects()).toEqual(['stop, wrong file'])
})

test('clearInterjects drops pending items and reports the count', () => {
  enqueueInterject('a')
  enqueueInterject('b')
  expect(clearInterjects()).toBe(2)
  expect(hasPendingInterjects()).toBe(false)
  expect(clearInterjects()).toBe(0)
})
