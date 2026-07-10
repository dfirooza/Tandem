'use client'

import { useEffect, useRef } from 'react'
import { LiveMap } from '@liveblocks/client'
import {
  LiveblocksProvider,
  RoomProvider,
  useOthers,
  useSelf,
  useStorage,
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

function SessionPanels({ emailById }: { emailById: Record<string, string> }) {
  const sessions = useStorage((root) => root.sessions)

  // useStorage snapshots a LiveMap as a plain readonly object keyed by sessionId.
  if (sessions === null) return <p style={{ color: '#555' }}>Connecting to live session feed…</p>
  const entries = Object.entries(sessions)
  if (entries.length === 0) return <p style={{ color: '#555' }}>No sessions yet.</p>

  return (
    <div>
      {entries.map(([sessionId, session]) => (
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
}: {
  roomId: string
  selfEmail: string
  emailById: Record<string, string>
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
          initialPresence={{ email: selfEmail }}
          initialStorage={{ sessions: new LiveMap() }}
        >
          <PresenceList />
          <SessionPanels emailById={emailById} />
        </RoomProvider>
      </LiveblocksProvider>
    </section>
  )
}
