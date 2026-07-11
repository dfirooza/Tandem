'use client'

import { useEffect, useRef, useState } from 'react'
import { branchSession } from './actions'
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

const PANEL_CLASS = 'card mb-3 p-3'
const OUTPUT_CLASS =
  'm-0 h-64 overflow-y-auto rounded-md border border-border bg-background p-3 ' +
  'font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground/90'

function PresenceList() {
  const others = useOthers()
  const self = useSelf()

  const emails = [
    ...(self ? [`${self.presence.email} (you)`] : []),
    ...others.map((o) => o.presence.email),
  ]

  return (
    <p className="mb-4 flex items-center gap-2 text-xs text-secondary">
      <span className="status-dot status-dot--active" aria-hidden />
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
              className="ml-0.5 rounded px-1 text-[0.7rem] font-medium text-white"
              style={{
                background: CURSOR_COLORS[o.connectionId % CURSOR_COLORS.length],
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

/**
 * Renders a session's events as individual spans; hovering an event reveals
 * a "Branch from here" button. Clicking branches at that event (copying
 * events [0..index] into a new session, executed by tandem-server).
 */
function EventSpans({
  sessionId,
  events,
}: {
  sessionId: string
  events: readonly { content: string }[]
}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const [pending, setPending] = useState(false)

  async function handleBranch(eventCount: number) {
    if (pending) return
    setPending(true)
    const result = await branchSession(sessionId, eventCount)
    setPending(false)
    if (result.error) alert(`Branch failed: ${result.error}`)
  }

  return (
    <>
      {events.map((e, i) => (
        <span
          key={i}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
          className={`relative ${hovered === i ? 'bg-accent/15' : ''}`}
        >
          {e.content}
          {hovered === i && (
            <button
              onClick={() => handleBranch(i + 1)}
              disabled={pending}
              title={`Branch a new session from event ${i + 1}`}
              className="absolute -top-1 right-0 z-[5] cursor-pointer rounded border border-accent/50 bg-surface px-1.5 py-0.5 font-sans text-[0.7rem] font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:cursor-wait disabled:opacity-60"
            >
              ⑂ {pending ? 'branching…' : 'branch from here'}
            </button>
          )}
        </span>
      ))}
    </>
  )
}

function PanelHeader({
  email,
  status,
  sessionId,
  statusSuffix = '',
  parentSessionId,
  parentEmail,
}: {
  email: string
  status: string
  sessionId: string
  statusSuffix?: string
  parentSessionId: string | null | undefined
  parentEmail: string | null
}) {
  return (
    <p className="mb-3 mt-0">
      <span className="flex flex-wrap items-center gap-2">
        <span
          className={`status-dot ${status === 'active' ? 'status-dot--active' : 'status-dot--ended'}`}
          aria-hidden
        />
        <strong className="text-[13px]">{email}</strong>
        <span className={`text-[13px] ${status === 'active' ? 'text-accent' : 'text-muted'}`}>
          ({status}
          {statusSuffix})
        </span>
        <span className="font-mono text-xs text-muted">{sessionId}</span>
      </span>
      {parentSessionId && (
        <span className="mt-1 block text-xs text-accent-hover">
          ⑂ branched from {parentEmail ?? parentSessionId.slice(0, 8)}{' '}
          <span className="font-mono text-muted">({parentSessionId.slice(0, 8)})</span>
        </span>
      )}
    </p>
  )
}

function SessionPanel({
  sessionId,
  session,
  email,
  parentEmail,
}: {
  sessionId: string
  session: {
    userId: string
    status: string
    parentSessionId?: string | null
    events: readonly { eventType: string; content: string; timestamp: string }[]
  }
  email: string
  parentEmail: string | null
}) {
  const outputRef = useRef<HTMLPreElement>(null)

  // Auto-scroll smoothly to the newest output as events stream in.
  useEffect(() => {
    const el = outputRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [session.events.length])

  return (
    <div className={PANEL_CLASS}>
      <PanelHeader
        email={email}
        status={session.status}
        sessionId={sessionId}
        parentSessionId={session.parentSessionId}
        parentEmail={parentEmail}
      />
      <pre ref={outputRef} className={OUTPUT_CLASS}>
        <EventSpans sessionId={sessionId} events={session.events} />
      </pre>
    </div>
  )
}

export interface HistorySession {
  sessionId: string
  userId: string
  status: string
  parentSessionId: string | null
  events: { content: string }[]
}

function SessionPanels({
  emailById,
  historySessions,
  ownerBySessionId,
}: {
  emailById: Record<string, string>
  historySessions: HistorySession[]
  ownerBySessionId: Record<string, string>
}) {
  const sessions = useStorage((root) => root.sessions)

  // useStorage snapshots a LiveMap as a plain readonly object keyed by sessionId.
  if (sessions === null)
    return <p className="text-muted">Connecting to live session feed…</p>
  const entries = Object.entries(sessions)

  // Resolve a parent session's owner email for the lineage label. Owners come
  // from the page's durable query, falling back to live storage for sessions
  // created after page load.
  const parentEmailFor = (parentId: string | null | undefined): string | null => {
    if (!parentId) return null
    const ownerId = ownerBySessionId[parentId] ?? sessions[parentId]?.userId
    return ownerId ? (emailById[ownerId] ?? ownerId) : null
  }

  // Late-joiner backfill: sessions whose durable history exists in Supabase
  // but whose events are missing from Liveblocks storage (cleared/reset).
  // Rendered as static panels above the live section.
  const liveIdsWithEvents = new Set(
    entries.filter(([, s]) => s.events.length > 0).map(([id]) => id)
  )
  const backfill = historySessions.filter(
    (h) => !liveIdsWithEvents.has(h.sessionId) && h.events.length > 0
  )
  const backfillIds = new Set(backfill.map((h) => h.sessionId))
  // Hide a live panel only when it's empty AND replaced by a history panel.
  const liveEntries = entries.filter(([id]) => !backfillIds.has(id))

  if (backfill.length === 0 && liveEntries.length === 0)
    return <p className="text-muted">No sessions yet.</p>

  return (
    <div>
      {backfill.length > 0 && (
        <div>
          <h3 className="eyebrow mb-3 mt-2">History (from durable log)</h3>
          {backfill.map((h) => (
            <div key={h.sessionId} className={PANEL_CLASS}>
              <PanelHeader
                email={emailById[h.userId] ?? h.userId}
                status={h.status}
                statusSuffix=" — history"
                sessionId={h.sessionId}
                parentSessionId={h.parentSessionId}
                parentEmail={parentEmailFor(h.parentSessionId)}
              />
              <pre className={OUTPUT_CLASS}>
                <EventSpans sessionId={h.sessionId} events={h.events} />
              </pre>
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
          parentEmail={parentEmailFor(session.parentSessionId)}
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
  ownerBySessionId,
}: {
  roomId: string
  selfEmail: string
  emailById: Record<string, string>
  historySessions: HistorySession[]
  ownerBySessionId: Record<string, string>
}) {
  const publicKey = process.env.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY

  if (!publicKey) {
    return (
      <section>
        <h2 className="section-title">Live Sessions</h2>
        <p className="error max-w-none">
          NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY is not set — live sessions are disabled.
        </p>
      </section>
    )
  }

  return (
    <section>
      <h2 className="section-title">Live Sessions</h2>
      <LiveblocksProvider publicApiKey={publicKey}>
        <RoomProvider
          id={`tandem-room-${roomId}`}
          initialPresence={{ email: selfEmail, cursor: null }}
          initialStorage={{ sessions: new LiveMap() }}
        >
          <CursorTracking>
            <PresenceList />
            <SessionPanels
              emailById={emailById}
              historySessions={historySessions}
              ownerBySessionId={ownerBySessionId}
            />
          </CursorTracking>
        </RoomProvider>
      </LiveblocksProvider>
    </section>
  )
}
