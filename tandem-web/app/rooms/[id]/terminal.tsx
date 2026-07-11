'use client'

import { useEffect, useRef } from 'react'
import type { Terminal as XTerminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

// Real terminal rendering for ACTIVE sessions (Stage 10), fed the raw PTY
// chunks (ANSI codes intact). When `interactive`, keystrokes are captured
// via xterm's onData and handed to the caller (which sends them over the
// control WebSocket) — actual authorization happens server-side.

export default function SessionTerminal({
  events,
  interactive,
  onInput,
}: {
  events: readonly { content: string; raw?: string }[]
  interactive: boolean
  onInput: (data: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerminal | null>(null)
  const writtenRef = useRef(0)
  // Latest interactivity/input handler, readable from the once-registered
  // onData listener without re-registering.
  const interactiveRef = useRef(interactive)
  const onInputRef = useRef(onInput)
  const eventsRef = useRef(events)
  interactiveRef.current = interactive
  onInputRef.current = onInput
  eventsRef.current = events

  // Mount: dynamic import (xterm touches window; SSR must not evaluate it).
  useEffect(() => {
    let disposed = false
    let term: XTerminal | null = null
    let observer: ResizeObserver | null = null

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ])
      if (disposed || !containerRef.current) return

      term = new Terminal({
        fontSize: 12,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        theme: {
          background: '#000000',
          foreground: '#ffffff',
          cursor: '#3291ff',
          selectionBackground: '#3291ff44',
        },
        scrollback: 5000,
        convertEol: false,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(containerRef.current)
      fit.fit()

      term.onData((data) => {
        if (interactiveRef.current) onInputRef.current(data)
      })

      observer = new ResizeObserver(() => fit.fit())
      observer.observe(containerRef.current)

      termRef.current = term
      // Replay everything that arrived before the async import resolved.
      const current = eventsRef.current
      for (const e of current) term.write(e.raw ?? e.content)
      writtenRef.current = current.length
    })()

    return () => {
      disposed = true
      observer?.disconnect()
      term?.dispose()
      termRef.current = null
    }
  }, [])

  // Stream: write only chunks not yet written (raw preferred over stripped).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    for (let i = writtenRef.current; i < events.length; i++) {
      term.write(events[i].raw ?? events[i].content)
    }
    writtenRef.current = events.length
  }, [events.length, events])

  return (
    <div
      ref={containerRef}
      className={`h-72 overflow-hidden rounded-md border bg-background p-1 ${
        interactive ? 'border-accent' : 'border-border'
      }`}
    />
  )
}
