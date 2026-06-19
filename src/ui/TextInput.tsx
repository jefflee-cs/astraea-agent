// Vendored from `ink-text-input` with one fix: cursor follows external value changes.
//
// 原版把 cursorOffset 当组件内部 state，只在 mount 时初始化为 value.length，之后对
// 外部 value 变化只做「往回夹」（cursor > len 时夹到末尾），从不「往后推」。于是当
// 父组件从外部把 value 改长（粘贴、历史回溯、/命令补全都是 setInputValue(prev+...)），
// 光标会原地不动——空输入框粘贴后光标停在 0，下一次按键插到最前面。
//
// 修复：用 lastEmittedRef 记住组件自己上一次 onChange 吐出的值。渲染时若传入的 value
// 与之不同，说明这次变化来自外部 → 把光标推到新末尾。组件自身的按键编辑因为先经过
// onChange、父组件再回传同样的值，lastEmittedRef 已对齐，不会误触发，光标保持原位。
import React, { useEffect, useRef, useState } from 'react'
import { Text, useInput, usePaste } from 'ink'
import chalk from 'chalk'

export interface TextInputProps {
  value: string
  placeholder?: string
  focus?: boolean
  mask?: string
  highlightPastedText?: boolean
  showCursor?: boolean
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  // 传了 onPaste（或仅 enablePaste）时，本组件自己监听 bracketed-paste 事件，
  // 把整段粘贴插到光标处。用于 /login 这类「自己就是焦点输入框」的场景；主输入框
  // 不传，由 App 顶层的 usePaste 统一处理（避免双份粘贴）。
  enablePaste?: boolean
}

export default function TextInput({
  value: originalValue,
  placeholder = '',
  focus = true,
  mask,
  highlightPastedText = false,
  showCursor = true,
  onChange,
  onSubmit,
  enablePaste = false,
}: TextInputProps) {
  const [state, setState] = useState({
    cursorOffset: (originalValue || '').length,
    cursorWidth: 0,
  })
  const { cursorOffset, cursorWidth } = state

  // 组件自己上一次吐给父组件的值。初始 = 当前值（mount 时不算外部变化）。
  const lastEmittedRef = useRef(originalValue)

  // valueRef / offsetRef 永远持有「最新」的值与光标位置，且在按键回调里 *同步* 更新。
  // Windows 终端在没开 bracketed-paste 时，会把粘贴拆成一串单字符事件，在同一个事件
  // 循环 tick 里连续触发 useInput——此时 React 还没重渲染，闭包里的 originalValue /
  // cursorOffset 全是旧值。若直接基于 prop 计算，每个字符都从「空串第 0 位」插入，
  // 最后只剩最后一个字符（这就是 Windows「粘贴只显示一个字符」的根因）。改成读写 ref
  // 后，连续事件能彼此累加。
  const valueRef = useRef(originalValue)
  const offsetRef = useRef(state.cursorOffset)

  useEffect(() => {
    if (!focus || !showCursor) return
    const newValue = originalValue || ''
    if (originalValue !== lastEmittedRef.current) {
      // 外部改了 value（粘贴 / 历史 / 补全 / 清空）→ 光标跟到末尾。
      lastEmittedRef.current = originalValue
      valueRef.current = newValue
      offsetRef.current = newValue.length
      setState({ cursorOffset: newValue.length, cursorWidth: 0 })
      return
    }
    // 自身编辑导致的回传：保持 ref 与最新值同步，只在越界时把光标夹回。
    valueRef.current = newValue
    if (offsetRef.current > newValue.length) offsetRef.current = newValue.length
    setState(prev =>
      prev.cursorOffset > newValue.length
        ? { cursorOffset: newValue.length, cursorWidth: 0 }
        : prev,
    )
  }, [originalValue, focus, showCursor])

  // 自己监听整段粘贴：插到当前光标处。只在显式开启且获得焦点时激活，
  // 这样同一时刻全局只有一个 paste 监听者，不会和 App 顶层的 usePaste 抢。
  usePaste(
    (text) => {
      if (!text) return
      const base = valueRef.current
      const at = offsetRef.current
      const next = base.slice(0, at) + text + base.slice(at)
      const nextOffset = at + text.length
      valueRef.current = next
      offsetRef.current = nextOffset
      lastEmittedRef.current = next
      setState({ cursorOffset: nextOffset, cursorWidth: 0 })
      onChange(next)
    },
    { isActive: enablePaste && focus },
  )

  const cursorActualWidth = highlightPastedText ? cursorWidth : 0
  const value = mask ? mask.repeat(originalValue.length) : originalValue
  let renderedValue = value
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined

  // 伪光标：用反色块模拟，避免直接操作真实光标和 ANSI 转义。
  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(' ')
    renderedValue = value.length > 0 ? '' : chalk.inverse(' ')
    let i = 0
    for (const char of value) {
      renderedValue +=
        i >= cursorOffset - cursorActualWidth && i <= cursorOffset
          ? chalk.inverse(char)
          : char
      i++
    }
    if (value.length > 0 && cursorOffset === value.length) {
      renderedValue += chalk.inverse(' ')
    }
  }

  useInput(
    (input, key) => {
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && input === 'c') ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return
      }

      // 一律以 ref（最新值）为基准，而非可能过期的 prop。这样 Windows 把粘贴拆成
      // 一串同步单字符事件时也能逐个累加，而不是只留最后一个字符。
      const prevValue = valueRef.current
      const prevOffset = offsetRef.current

      if (key.return) {
        onSubmit?.(prevValue)
        return
      }

      let nextCursorOffset = prevOffset
      let nextValue = prevValue
      let nextCursorWidth = 0

      if (key.leftArrow) {
        if (showCursor) nextCursorOffset--
      } else if (key.rightArrow) {
        if (showCursor) nextCursorOffset++
      } else if (key.backspace || key.delete) {
        if (prevOffset > 0) {
          nextValue =
            prevValue.slice(0, prevOffset - 1) +
            prevValue.slice(prevOffset, prevValue.length)
          nextCursorOffset--
        }
      } else {
        nextValue =
          prevValue.slice(0, prevOffset) +
          input +
          prevValue.slice(prevOffset, prevValue.length)
        nextCursorOffset += input.length
        if (input.length > 1) nextCursorWidth = input.length
      }

      if (nextCursorOffset < 0) nextCursorOffset = 0
      if (nextCursorOffset > nextValue.length) nextCursorOffset = nextValue.length

      // 同步写回 ref，让同一 tick 内的后续事件接着这一步继续累加。
      offsetRef.current = nextCursorOffset
      setState({ cursorOffset: nextCursorOffset, cursorWidth: nextCursorWidth })

      if (nextValue !== prevValue) {
        valueRef.current = nextValue
        // 记住这次自己吐出的值，让上面的 useEffect 不把它误判为外部变化。
        lastEmittedRef.current = nextValue
        onChange(nextValue)
      }
    },
    { isActive: focus },
  )

  return (
    <Text>
      {placeholder
        ? value.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  )
}
