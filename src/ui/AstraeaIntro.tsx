// AstraeaIntro — one-shot boot animation.
//
// A silver shine sweeps left→right across the indigo "Astraea" wordmark exactly
// once (~1s), then calls onDone(). The caller then commits the settled wordmark
// into <Static> as the permanent header (see App.tsx boot phase).
//
// Lives in the live (non-Static) region only while booting — never repaints after.
// Skippable: any keypress finishes immediately. No-ops on terminals too narrow
// for the block wordmark (calls onDone right away so boot isn't blocked).

import React, { useEffect, useRef, useState } from 'react'
import { useInput, useStdout } from 'ink'
import { AstraeaWordmark, WORDMARK_WIDTH, fitsWordmark } from './AstraeaWordmark'

const TICK_MS = 40          // frame interval
const STEP = 3              // columns the shine advances per frame
const BAND = 8              // lead/trail padding so the band fully enters & exits
const START = -BAND

export function AstraeaIntro({ onDone }: { onDone: () => void }): React.ReactNode {
  const { stdout } = useStdout()
  const columns = stdout?.columns ?? 80
  const narrow = !fitsWordmark(columns)

  const [pos, setPos] = useState(START)
  const posRef = useRef(START)
  const doneRef = useRef(false)

  const finish = () => {
    if (doneRef.current) return
    doneRef.current = true
    onDone()
  }

  useEffect(() => {
    // Too narrow for the block art → skip the animation, don't block boot.
    if (narrow) { finish(); return }

    const id = setInterval(() => {
      posRef.current += STEP
      if (posRef.current > WORDMARK_WIDTH + BAND) {
        clearInterval(id)
        finish()
        return
      }
      setPos(posRef.current)
    }, TICK_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow])

  // Any keypress skips the intro.
  useInput(() => finish())

  if (narrow) return null
  return <AstraeaWordmark shineCenter={pos} />
}
