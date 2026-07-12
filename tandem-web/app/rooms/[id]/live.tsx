'use client'

import { useEffect, useRef, useState } from 'react'
import {
  branchSession,
  requestControl,
  approveControl,
  denyControl,
  releaseControl,
} from './actions'
import SessionTerminal from './terminal'
import { useControlSocket } from './control-socket'
import { LiveList, LiveMap } from '@liveblocks/client'
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

/** Seconds remaining toward the 30s control-request timeout. */
function Countdown({ since }: { since: string }) {
  const compute = () =>
    Math.max(0, 30 - Math.floor((Date.now() - new Date(since).getTime()) / 1000))
  const [remaining, setRemaining] = useState(compute)
  useEffect(() => {
    const t = setInterval(() => setRemaining(compute()), 500)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [since])
  return <span className="font-mono">{remaining}s</span>
}

/**
 * Control state UI for an active session. Purely reflects the server's
 * Liveblocks mirror; every action goes through tandem-server, which is the
 * sole authority (this UI cannot grant anything by itself).
 */
function ControlBar({
  sessionId,
  isOwner,
  selfId,
  controllerId,
  pendingRequesterId,
  pendingRequestedAt,
  emailById,
}: {
  sessionId: string
  isOwner: boolean
  selfId: string
  controllerId: string | null | undefined
  pendingRequesterId: string | null | undefined
  pendingRequestedAt: string | null | undefined
  emailById: Record<string, string>
}) {
  const [busy, setBusy] = useState(false)

  async function act(fn: (id: string) => Promise<{ ok?: true; error?: string }>) {
    if (busy) return
    setBusy(true)
    const result = await fn(sessionId)
    setBusy(false)
    if (result.error) alert(`Control action failed: ${result.error}`)
  }

  const btn = 'btn-ghost px-2 py-0.5 text-xs disabled:cursor-wait disabled:opacity-50'
  const btnPrimary =
    'btn-primary px-2 py-0.5 text-xs disabled:cursor-wait disabled:opacity-50'

  if (controllerId) {
    const mine = controllerId === selfId
    return (
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className={mine ? 'text-accent' : 'text-warning'}>
          {mine
            ? 'You have control of this session'
            : `Controlled by ${emailById[controllerId] ?? controllerId}`}
        </span>
        {mine && (
          <button className={btn} disabled={busy} onClick={() => act(releaseControl)}>
            Release control
          </button>
        )}
        {isOwner && !mine && (
          <button className={btn} disabled={busy} onClick={() => act(releaseControl)}>
            Revoke control
          </button>
        )}
      </div>
    )
  }

  if (pendingRequesterId) {
    if (isOwner) {
      return (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-warning">
            {emailById[pendingRequesterId] ?? pendingRequesterId} requests control
            {pendingRequestedAt && (
              <>
                {' '}
                (<Countdown since={pendingRequestedAt} />)
              </>
            )}
          </span>
          <button
            className={btnPrimary}
            disabled={busy}
            onClick={() => act(approveControl)}
          >
            Approve
          </button>
          <button className={btn} disabled={busy} onClick={() => act(denyControl)}>
            Deny
          </button>
        </div>
      )
    }
    if (pendingRequesterId === selfId) {
      return (
        <p className="mb-2 text-xs text-muted">
          Control requested — waiting for the owner to approve
          {pendingRequestedAt && (
            <>
              {' '}
              (<Countdown since={pendingRequestedAt} />)
            </>
          )}
          . If this disappears without granting, the request was denied or timed
          out.
        </p>
      )
    }
    return <p className="mb-2 text-xs text-muted">A control request is pending…</p>
  }

  if (!isOwner) {
    return (
      <div className="mb-2">
        <button className={btn} disabled={busy} onClick={() => act(requestControl)}>
          Request control
        </button>
      </div>
    )
  }

  return null
}

function SessionPanel({
  sessionId,
  session,
  email,
  parentEmail,
  selfId,
  emailById,
}: {
  sessionId: string
  session: {
    userId: string
    status: string
    parentSessionId?: string | null
    controllerId?: string | null
    pendingRequesterId?: string | null
    pendingRequestedAt?: string | null
    events: readonly {
      eventType: string
      content: string
      raw?: string
      timestamp: string
    }[]
  }
  email: string
  parentEmail: string | null
  selfId: string
  emailById: Record<string, string>
}) {
  const outputRef = useRef<HTMLPreElement>(null)
  const { sendInput } = useControlSocket()
  const [branching, setBranching] = useState(false)

  // Branched sessions are static copies — "active" but with no CLI process
  // behind them (until live branch continuation is built), so they get the
  // text view and no control UI. Only real, connected sessions get xterm +
  // remote control.
  const isLiveSession = session.status === 'active' && !session.parentSessionId
  const hasControl = isLiveSession && session.controllerId === selfId

  // Auto-scroll smoothly to the newest output as events stream in
  // (text panels only — xterm manages its own scrollback).
  useEffect(() => {
    const el = outputRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [session.events.length])

  async function branchNow() {
    if (branching || session.events.length === 0) return
    setBranching(true)
    const result = await branchSession(sessionId, session.events.length)
    setBranching(false)
    if (result.error) alert(`Branch failed: ${result.error}`)
  }

  return (
    <div className={PANEL_CLASS}>
      <div className="flex items-start justify-between gap-2">
        <PanelHeader
          email={email}
          status={session.status}
          sessionId={sessionId}
          parentSessionId={session.parentSessionId}
          parentEmail={parentEmail}
        />
        {isLiveSession && session.events.length > 0 && (
          <button
            onClick={branchNow}
            disabled={branching}
            title="Branch a new session from the current point"
            className="btn-ghost shrink-0 px-2 py-0.5 text-xs disabled:cursor-wait disabled:opacity-50"
          >
            ⑂ {branching ? 'branching…' : 'branch'}
          </button>
        )}
      </div>

      {isLiveSession ? (
        <>
          <ControlBar
            sessionId={sessionId}
            isOwner={session.userId === selfId}
            selfId={selfId}
            controllerId={session.controllerId}
            pendingRequesterId={session.pendingRequesterId}
            pendingRequestedAt={session.pendingRequestedAt}
            emailById={emailById}
          />
          <SessionTerminal
            events={session.events}
            interactive={hasControl}
            onInput={(data) => sendInput(sessionId, data)}
          />
        </>
      ) : (
        <pre ref={outputRef} className={OUTPUT_CLASS}>
          <EventSpans sessionId={sessionId} events={session.events} />
        </pre>
      )}
    </div>
  )
}

export interface HistorySession {
  sessionId: string
  userId: string
  status: string
  parentSessionId: string | null
  lastSummary: string | null
  lastSummaryAt: string | null
  events: { content: string }[]
}

/** "12s ago" / "3m ago", ticking every 10s. */
function RelativeTime({ since }: { since: string }) {
  const compute = () => {
    const s = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000))
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
  }
  const [label, setLabel] = useState(compute)
  useEffect(() => {
    const t = setInterval(() => setLabel(compute()), 10_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [since])
  return <span>{label}</span>
}

/**
 * Compact "who's doing what" row (Stage 11/12): summary + owner + relative
 * time; clicking expands into the full session view, clicking again
 * collapses. Used for active sessions AND history entries.
 */
function CompactSessionRow({
  email,
  summary,
  active,
  timeSince,
  expanded,
  onToggle,
}: {
  email: string
  summary: string
  active: boolean
  timeSince?: string | null
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className={`flex w-full cursor-pointer items-center gap-2.5 bg-transparent px-3 py-2 text-left transition-colors hover:bg-surface-hover ${
        expanded ? 'bg-surface-hover' : ''
      }`}
    >
      <span
        className={`status-dot ${active ? 'status-dot--active' : 'status-dot--ended'}`}
        aria-hidden
      />
      <span className="shrink-0 text-[13px] font-medium text-foreground">{email}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-secondary">
        {summary}
      </span>
      {timeSince && (
        <span className="shrink-0 text-[11px] text-muted">
          <RelativeTime since={timeSince} />
        </span>
      )}
      <span className="shrink-0 text-[11px] text-muted">{expanded ? '▾' : '▸'}</span>
    </button>
  )
}

/**
 * History row: who, when, what was accomplished. Only rendered for entries
 * that HAVE a real summary (everything else is filtered out upstream);
 * clicking expands into the full raw content, clicking again collapses.
 */
function HistoryRow({
  email,
  summary,
  isBranch,
  at,
  expanded,
  onToggle,
}: {
  email: string
  summary: string
  isBranch: boolean
  at: string | null
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className={`flex w-full cursor-pointer items-center gap-2.5 bg-transparent px-3 py-2 text-left transition-colors hover:bg-surface-hover ${
        expanded ? 'bg-surface-hover' : ''
      }`}
    >
      <span className="status-dot status-dot--ended" aria-hidden />
      <span className="shrink-0 text-[13px] font-medium text-foreground">{email}</span>
      {isBranch && (
        <span className="shrink-0 rounded-[4px] border border-border px-1 text-[10px] uppercase tracking-wider text-muted">
          branch
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[13px] text-secondary">
        {summary}
      </span>
      {at && (
        <span className="shrink-0 text-[11px] text-muted">
          <RelativeTime since={at} />
        </span>
      )}
      <span className="shrink-0 text-[11px] text-muted">{expanded ? '▾' : '▸'}</span>
    </button>
  )
}

function SessionPanels({
  emailById,
  historySessions,
  ownerBySessionId,
  selfId,
}: {
  emailById: Record<string, string>
  historySessions: HistorySession[]
  ownerBySessionId: Record<string, string>
  selfId: string
}) {
  const sessions = useStorage((root) => root.sessions)
  // Which active sessions are expanded into the full drill-down view.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  // useStorage snapshots a LiveMap as a plain readonly object keyed by sessionId.
  if (sessions === null)
    return <p className="text-muted">Connecting to live session feed…</p>
  const entries = Object.entries(sessions)

  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Resolve a parent session's owner email for the lineage label. Owners come
  // from the page's durable query, falling back to live storage for sessions
  // created after page load.
  const parentEmailFor = (parentId: string | null | undefined): string | null => {
    if (!parentId) return null
    const ownerId = ownerBySessionId[parentId] ?? sessions[parentId]?.userId
    return ownerId ? (emailById[ownerId] ?? ownerId) : null
  }

  // All live-map entries render somewhere; durable-only history (storage
  // cleared/reset, or pre-Liveblocks sessions) is folded into historyItems
  // below via historySessions — summaries only, never raw events.
  const liveEntries = entries

  // Compact treatment (Stage 11/12): REAL live sessions (active, non-branch)
  // get the active list. History is strictly who/when/what: only entries
  // with a real summary appear, as flat single-line rows — no raw content,
  // no placeholders. Unsummarized ended sessions simply don't show (the
  // durable session_events record is untouched, just not surfaced here).
  const activeEntries = liveEntries.filter(
    ([, s]) => s.status === 'active' && !s.parentSessionId
  )
  const staticEntries = liveEntries.filter(
    ([, s]) => s.status !== 'active' || s.parentSessionId
  )

  const liveMapIds = new Set(entries.map(([id]) => id))
  type LiveSessionSnapshot = (typeof staticEntries)[number][1]
  const historyItems: {
    id: string
    email: string
    summary: string
    isBranch: boolean
    at: string | null
    /** Expansion payload: full live-map session or durable-log record. */
    source:
      | { kind: 'live'; session: LiveSessionSnapshot }
      | { kind: 'durable'; record: HistorySession }
  }[] = []
  for (const [id, s] of staticEntries) {
    if (!s.lastSummary) continue
    historyItems.push({
      id,
      email: emailById[s.userId] ?? s.userId,
      summary: s.lastSummary,
      isBranch: !!s.parentSessionId,
      at: s.lastSummaryAt ?? null,
      source: { kind: 'live', session: s },
    })
  }
  for (const h of historySessions) {
    if (liveMapIds.has(h.sessionId)) continue // already covered above
    if (!h.lastSummary) continue
    if (h.status === 'active' && !h.parentSessionId) continue // not history
    historyItems.push({
      id: h.sessionId,
      email: emailById[h.userId] ?? h.userId,
      summary: h.lastSummary,
      isBranch: !!h.parentSessionId,
      at: h.lastSummaryAt,
      source: { kind: 'durable', record: h },
    })
  }
  historyItems.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))

  if (activeEntries.length === 0 && historyItems.length === 0)
    return <p className="text-muted">No sessions yet.</p>

  return (
    <div>
      {activeEntries.length > 0 && (
        <div className="card mb-4 divide-y divide-border overflow-hidden">
          {activeEntries.map(([sessionId, session]) => (
            <div key={sessionId}>
              <CompactSessionRow
                email={emailById[session.userId] ?? session.userId}
                summary={session.lastSummary ?? 'Just started…'}
                active
                timeSince={session.lastSummaryAt}
                expanded={expandedIds.has(sessionId)}
                onToggle={() => toggleExpanded(sessionId)}
              />
              {expandedIds.has(sessionId) && (
                <div className="border-t border-border p-3">
                  <SessionPanel
                    sessionId={sessionId}
                    session={session}
                    email={emailById[session.userId] ?? session.userId}
                    parentEmail={parentEmailFor(session.parentSessionId)}
                    selfId={selfId}
                    emailById={emailById}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {historyItems.length > 0 && (
        <>
          <h3 className="eyebrow mb-3 mt-2">History</h3>
          <div className="card mb-4 divide-y divide-border overflow-hidden">
            {historyItems.map((item) => (
              <div key={item.id}>
                <HistoryRow
                  email={item.email}
                  summary={item.summary}
                  isBranch={item.isBranch}
                  at={item.at}
                  expanded={expandedIds.has(item.id)}
                  onToggle={() => toggleExpanded(item.id)}
                />
                {expandedIds.has(item.id) &&
                  (item.source.kind === 'live' ? (
                    <div className="border-t border-border p-3">
                      <SessionPanel
                        sessionId={item.id}
                        session={item.source.session}
                        email={item.email}
                        parentEmail={parentEmailFor(item.source.session.parentSessionId)}
                        selfId={selfId}
                        emailById={emailById}
                      />
                    </div>
                  ) : (
                    <div className="border-t border-border p-3">
                      <div className={PANEL_CLASS}>
                        <PanelHeader
                          email={item.email}
                          status={item.source.record.status}
                          statusSuffix=" — history"
                          sessionId={item.id}
                          parentSessionId={item.source.record.parentSessionId}
                          parentEmail={parentEmailFor(item.source.record.parentSessionId)}
                        />
                        <pre className={OUTPUT_CLASS}>
                          <EventSpans sessionId={item.id} events={item.source.record.events} />
                        </pre>
                      </div>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Shared Liveblocks room context for everything live on the room page
 * (session panels, presence, cursors, chat). One provider = one connection =
 * one presence entry per tab; mounting separate RoomProviders per panel
 * would double-count presence.
 */
export function RoomRealtime({
  roomId,
  selfEmail,
  children,
}: {
  roomId: string
  selfEmail: string
  children: React.ReactNode
}) {
  const publicKey = process.env.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY

  if (!publicKey) {
    // Misconfiguration: without the key none of the live features (or the
    // components calling Liveblocks hooks) can render.
    return (
      <p className="error m-8 max-w-none">
        NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY is not set — live sessions and chat
        are disabled.
      </p>
    )
  }

  return (
    <LiveblocksProvider publicApiKey={publicKey}>
      <RoomProvider
        id={`tandem-room-${roomId}`}
        initialPresence={{ email: selfEmail, cursor: null }}
        initialStorage={{ sessions: new LiveMap(), chatMessages: new LiveList([]) }}
      >
        {children}
      </RoomProvider>
    </LiveblocksProvider>
  )
}

export default function LiveSessionSection({
  emailById,
  historySessions,
  ownerBySessionId,
  selfId,
}: {
  emailById: Record<string, string>
  historySessions: HistorySession[]
  ownerBySessionId: Record<string, string>
  selfId: string
}) {
  return (
    <section>
      <h2 className="section-title">Live Sessions</h2>
      <CursorTracking>
        <PresenceList />
        <SessionPanels
          emailById={emailById}
          historySessions={historySessions}
          ownerBySessionId={ownerBySessionId}
          selfId={selfId}
        />
      </CursorTracking>
    </section>
  )
}
