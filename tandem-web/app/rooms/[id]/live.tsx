'use client'

import { useEffect, useRef } from 'react'
import { LiveMap } from '@liveblocks/client'
import {
  LiveblocksProvider,
  RoomProvider,
  useOthers,
  useSelf,
  useStorage,
  useUpdateMyPresence,
} from '@liveblocks/react'

// Live session panels + presence for a room. Storage is written exclusively
// by tandem-server; this component only reads it. See liveblocks.config.ts
// for the shared shape.

const PANEL_STYLE: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 4,
  padding: '0.5rem',
  marginBottom: '1rem',
}

const OUTPUT_STYLE: React.CSSProperties = {
  background: '#111',
  color: '#ddd',
  fontFamily: 'monospace',
  fontSize: '0.8rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  height: '16rem',
  overflowY: 'auto',
  padding: '0.5rem',
  margin: 0,
}

function PresenceList() {
  const others = useOthers()
  const self = useSelf()

  const emails = [
    ...(self ? [`${self.presence.email} (you)`] : []),
    ...others.map((o) => o.presence.email),
  ]

  return (
    <p style={{ color: '#555', fontSize: '0.875rem' }}>
      Online now: {emails.length > 0 ? emails.join(', ') : '…'}
    </p>
  )
}

const CURSOR_COLORS = ['#e91e63', '#2196f3', '#ff9800', '#4caf50', '#9c27b0']

function Cursors() {
  const others = useOthers()
  return (
    <>
      {others
        .filter((o) => o.presence.cursor !== null)
        .map((o) => (
          <div
            key={o.connectionId}
            style={{
              position: 'absolute',
              left: o.presence.cursor!.x,
              top: o.presence.cursor!.y,
              pointerEvents: 'none',
              zIndex: 10,
              transform: 'translate(-2px, -2px)',
            }}
          >
            <span
              style={{
                color: CURSOR_COLORS[o.connectionId % CURSOR_COLORS.length],
                fontSize: '1rem',
              }}
            >
              ➤
            </span>
            <span
              style={{
                background: CURSOR_COLORS[o.connectionId % CURSOR_COLORS.length],
                color: '#fff',
                fontSize: '0.7rem',
                padding: '0 0.25rem',
                borderRadius: 2,
                marginLeft: 2,
              }}
            >
              {o.presence.email}
            </span>
          </div>
        ))}
    </>
  )
}

/** Tracks the pointer over the live section and shares it via presence. */
function CursorTracking({ children }: { children: React.ReactNode }) {
  const updateMyPresence = useUpdateMyPresence()
  return (
    <div
      style={{ position: 'relative' }}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        updateMyPresence({
          cursor: { x: e.clientX - rect.left, y: e.clientY - rect.top },
        })
      }}
      onPointerLeave={() => updateMyPresence({ cursor: null })}
    >
      <Cursors />
      {children}
    </div>
  )
}

function SessionPanel({
  sessionId,
  session,
  email,
}: {
  sessionId: string
  session: {
    userId: string
    status: string
    events: readonly { eventType: string; content: string; timestamp: string }[]
  }
  email: string
}) {
  const outputRef = useRef<HTMLPreElement>(null)

  // Auto-scroll to the newest output as events stream in.
  useEffect(() => {
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session.events.length])

  return (
    <div style={PANEL_STYLE}>
      <p style={{ margin: '0 0 0.5rem' }}>
        <strong>{email}</strong>{' '}
        <span style={{ color: session.status === 'active' ? '#0a0' : '#888' }}>
          ({session.status})
        </span>{' '}
        <span style={{ color: '#aaa', fontSize: '0.75rem' }}>{sessionId}</span>
      </p>
      <pre ref={outputRef} style={OUTPUT_STYLE}>
        {session.events.map((e) => e.content).join('')}
      </pre>
    </div>
  )
}

export interface HistorySession {
  sessionId: string
  userId: string
  status: string
  content: string
}

function SessionPanels({
  emailById,
  historySessions,
}: {
  emailById: Record<string, string>
  historySessions: HistorySession[]
}) {
  const sessions = useStorage((root) => root.sessions)

  // useStorage snapshots a LiveMap as a plain readonly object keyed by sessionId.
  if (sessions === null) return <p style={{ color: '#555' }}>Connecting to live session feed…</p>
  const entries = Object.entries(sessions)

  // Late-joiner backfill: sessions whose durable history exists in Supabase
  // but whose events are missing from Liveblocks storage (cleared/reset).
  // Rendered as static panels above the live section.
  const liveIdsWithEvents = new Set(
    entries.filter(([, s]) => s.events.length > 0).map(([id]) => id)
  )
  const backfill = historySessions.filter(
    (h) => !liveIdsWithEvents.has(h.sessionId) && h.content.length > 0
  )
  const backfillIds = new Set(backfill.map((h) => h.sessionId))
  // Hide a live panel only when it's empty AND replaced by a history panel.
  const liveEntries = entries.filter(([id]) => !backfillIds.has(id))

  if (backfill.length === 0 && liveEntries.length === 0)
    return <p style={{ color: '#555' }}>No sessions yet.</p>

  return (
    <div>
      {backfill.length > 0 && (
        <div>
          <h3 style={{ margin: '0.5rem 0' }}>History (from durable log)</h3>
          {backfill.map((h) => (
            <div key={h.sessionId} style={PANEL_STYLE}>
              <p style={{ margin: '0 0 0.5rem' }}>
                <strong>{emailById[h.userId] ?? h.userId}</strong>{' '}
                <span style={{ color: '#888' }}>({h.status} — history)</span>{' '}
                <span style={{ color: '#aaa', fontSize: '0.75rem' }}>{h.sessionId}</span>
              </p>
              <pre style={OUTPUT_STYLE}>{h.content}</pre>
            </div>
          ))}
        </div>
      )}
      {liveEntries.map(([sessionId, session]) => (
        <SessionPanel
          key={sessionId}
          sessionId={sessionId}
          session={session}
          email={emailById[session.userId] ?? session.userId}
        />
      ))}
    </div>
  )
}

export default function LiveSessionSection({
  roomId,
  selfEmail,
  emailById,
  historySessions,
}: {
  roomId: string
  selfEmail: string
  emailById: Record<string, string>
  historySessions: HistorySession[]
}) {
  const publicKey = process.env.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY

  if (!publicKey) {
    return (
      <section>
        <h2>Live sessions</h2>
        <p style={{ color: '#a00' }}>
          NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY is not set — live sessions are disabled.
        </p>
      </section>
    )
  }

  return (
    <section>
      <h2>Live sessions</h2>
      <LiveblocksProvider publicApiKey={publicKey}>
        <RoomProvider
          id={`tandem-room-${roomId}`}
          initialPresence={{ email: selfEmail, cursor: null }}
          initialStorage={{ sessions: new LiveMap() }}
        >
          <CursorTracking>
            <PresenceList />
            <SessionPanels emailById={emailById} historySessions={historySessions} />
          </CursorTracking>
        </RoomProvider>
      </LiveblocksProvider>
    </section>
  )
}
