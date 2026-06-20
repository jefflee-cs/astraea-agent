// TodoPanel — 动态悬浮任务面板
// 轮询 todo-state，渲染当前会话的 todo 列表。
// 全部完成后显示 4s 提示，再由本组件负责 clearTodos。
// 主 Agent 空闲（idle）但仍有未完成 todo（模型忘了发收尾 TodoWrite）→ 渲染静态
// 「已暂停」终止态：不旋转、不清空，等下一轮或用户介入。

import React, { useState, useEffect, useRef } from 'react'
import { Box, Text } from 'ink'
import { getTodos, clearTodos } from '../services/todo-state'
import type { Todo, TodoStatus } from '../services/todo-state'
import { t } from '../i18n'

const POLL_MS = 300
const DONE_LINGER_MS = 4000

const ICON: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '◉',
  completed: '●',
}

const COLOR: Record<TodoStatus, string> = {
  pending: 'gray',
  in_progress: 'yellow',
  completed: 'green',
}

export function TodoPanel({
  namespace = 'main',
  idle = false,
  onComplete,
}: {
  namespace?: string
  idle?: boolean
  onComplete?: (count: number) => void
}) {
  const [todos, setTodos] = useState<Todo[]>([])
  const [showDone, setShowDone] = useState(false)
  // 用 ref 持有最新 onComplete，避免把每帧新建的回调塞进 effect 依赖导致反复触发
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  // 轮询 todo-state
  useEffect(() => {
    const id = setInterval(() => {
      setTodos(getTodos(namespace))
    }, POLL_MS)
    return () => clearInterval(id)
  }, [namespace])

  // 主 Agent 已空闲，但仍有未完成 todo → 模型忘了发收尾 TodoWrite。
  // 不自动清空（避免抹掉真正没做完的工作），改为渲染静态「已暂停」终止态。
  const openCount = todos.filter(t => t.status !== 'completed').length
  const paused = idle && openCount > 0

  // 检测全部完成 → 翻转 showDone（仅做状态判定，不持有定时器）
  // 进入「全部完成」的那一刻回调 onComplete，让上层把完成消息持久化进对话历史
  // （面板 4s 后就清空，光靠面板留不住痕迹）。每个完成回合只触发一次。
  useEffect(() => {
    const allDone = todos.length > 0 && todos.every(t => t.status === 'completed')
    if (allDone && !showDone) {
      setShowDone(true)
      onCompleteRef.current?.(todos.length)
    }
    if (!allDone && showDone) setShowDone(false)
  }, [todos, showDone])

  // showDone 置真后调度一次 clearTodos；定时器生命周期只绑 showDone，
  // 因而在 4s 内不会被中途 cleanup 掉（修复「所有任务已完成」长期滞留）
  useEffect(() => {
    if (!showDone) return
    const t = setTimeout(() => {
      clearTodos(namespace)
      setShowDone(false)
    }, DONE_LINGER_MS)
    return () => clearTimeout(t)
  }, [showDone, namespace])

  if (todos.length === 0) return null

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>  Tasks</Text>
      {todos.map(todo => {
        // 暂停态下，把 in_progress 的旋转 ◉ 换成静态 ⏸，避免「像在跑实际没跑」
        const showPausedIcon = paused && todo.status === 'in_progress'
        return (
          <Box key={todo.id}>
            <Text color={showPausedIcon ? 'gray' : COLOR[todo.status]}>
              {'  '}{showPausedIcon ? '⏸' : ICON[todo.status]}{'  '}{todo.content}
            </Text>
            {todo.priority === 'high' && (
              <Text color="red"> !</Text>
            )}
          </Box>
        )
      })}
      {showDone && (
        <Text color="green">{'  '}✓  {t('todoAllDone')}</Text>
      )}
      {paused && (
        <Text dimColor>{'  '}⏸  {t('todoPaused', { n: openCount })}</Text>
      )}
    </Box>
  )
}
