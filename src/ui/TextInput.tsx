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
import { Text, useInput } from 'ink'
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
}: TextInputProps) {
  const [state, setState] = useState({
    cursorOffset: (originalValue || '').length,
    cursorWidth: 0,
  })
  const { cursorOffset, cursorWidth } = state

  // 组件自己上一次吐给父组件的值。初始 = 当前值（mount 时不算外部变化）。
  const lastEmittedRef = useRef(originalValue)

  useEffect(() => {
    if (!focus || !showCursor) return
    const newValue = originalValue || ''
    if (originalValue !== lastEmittedRef.current) {
      // 外部改了 value（粘贴 / 历史 / 补全 / 清空）→ 光标跟到末尾。
      lastEmittedRef.current = originalValue
      setState({ cursorOffset: newValue.length, cursorWidth: 0 })
      return
    }
    // 自身编辑导致的回传：只在越界时夹一下，否则保持光标位置。
    setState(prev =>
      prev.cursorOffset > newValue.length
        ? { cursorOffset: newValue.length, cursorWidth: 0 }
        : prev,
    )
  }, [originalValue, focus, showCursor])

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

      if (key.return) {
        onSubmit?.(originalValue)
        return
      }

      let nextCursorOffset = cursorOffset
      let nextValue = originalValue
      let nextCursorWidth = 0

      if (key.leftArrow) {
        if (showCursor) nextCursorOffset--
      } else if (key.rightArrow) {
        if (showCursor) nextCursorOffset++
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          nextValue =
            originalValue.slice(0, cursorOffset - 1) +
            originalValue.slice(cursorOffset, originalValue.length)
          nextCursorOffset--
        }
      } else {
        nextValue =
          originalValue.slice(0, cursorOffset) +
          input +
          originalValue.slice(cursorOffset, originalValue.length)
        nextCursorOffset += input.length
        if (input.length > 1) nextCursorWidth = input.length
      }

      if (nextCursorOffset < 0) nextCursorOffset = 0
      if (nextCursorOffset > nextValue.length) nextCursorOffset = nextValue.length

      setState({ cursorOffset: nextCursorOffset, cursorWidth: nextCursorWidth })

      if (nextValue !== originalValue) {
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
