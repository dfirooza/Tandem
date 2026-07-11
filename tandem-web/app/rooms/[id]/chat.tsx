'use client'

import { useEffect, useRef, useState } from 'react'
import { useStorage } from '@liveblocks/react'
import { sendChatMessage } from './actions'

// Team chat panel (Stage 9). Renders as a persistent right-side column in
// the room view, inside the shared RoomRealtime provider. History comes from
// Supabase (server-fetched, durable); live updates arrive via the room's
// Liveblocks chatMessages list — same backfill pattern as session history.

export interface ChatHistoryMessage {
  id: string
  userId: string
  content: string
  timestamp: string
}

export default function ChatPanel({
  roomId,
  selfId,
  emailById,
  history,
}: {
  roomId: string
  selfId: string
  emailById: Record<string, string>
  history: ChatHistoryMessage[]
}) {
  // null while storage loads; undefined for rooms created before Stage 9.
  const live = useStorage((root) => root.chatMessages)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // Durable history first, then any live messages not yet in it.
  const seen = new Set(history.map((m) => m.id))
  const messages = [...history, ...(live ?? []).filter((m) => !seen.has(m.id))]

  // Auto-scroll to the newest message.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length])

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    const content = draft.trim()
    if (!content || sending) return
    setSending(true)
    const result = await sendChatMessage(roomId, content)
    setSending(false)
    if (result.error) {
      alert(`Send failed: ${result.error}`)
    } else {
      setDraft('')
    }
  }

  return (
    <aside className="sticky top-0 flex h-screen w-72 shrink-0 flex-col border-l border-border bg-sidebar">
      <p className="eyebrow m-0 border-b border-border px-4 py-3">Team Chat</p>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="text-xs text-muted">No messages yet. Say hi.</p>
        ) : (
          messages.map((m) => (
            <div key={m.id}>
              <p className="m-0 flex items-baseline gap-2 text-[11px]">
                <span
                  className={`font-medium ${m.userId === selfId ? 'text-accent' : 'text-secondary'}`}
                >
                  {emailById[m.userId] ?? m.userId}
                </span>
                <span className="text-muted">
                  {new Date(m.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </p>
              <p className="m-0 whitespace-pre-wrap break-words text-[13px] text-foreground">
                {m.content}
              </p>
            </div>
          ))
        )}
      </div>

      <form onSubmit={handleSend} className="flex gap-1.5 border-t border-border p-2">
        <input
          className="input mt-0 max-w-none flex-1"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message the room…"
          maxLength={4000}
        />
        <button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          className="btn-primary px-3 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </aside>
  )
}
