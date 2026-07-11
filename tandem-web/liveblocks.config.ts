import type { LiveList, LiveMap, LiveObject } from '@liveblocks/client'

// Global Liveblocks types (picked up by @liveblocks/react hooks).
// Must mirror what tandem-server writes: a LiveMap of sessions keyed by
// sessionId. tandem-server is the ONLY writer to Storage — the web app
// only reads it. Presence is set by web clients (who's viewing the room).
declare global {
  interface Liveblocks {
    Presence: {
      email: string
      /** Pointer position relative to the live section, null when outside. */
      cursor: { x: number; y: number } | null
    }
    Storage: {
      sessions: LiveMap<
        string,
        LiveObject<{
          userId: string
          status: string
          /** Set when the session was branched from another (Stage 5). */
          parentSessionId?: string | null
          events: LiveList<{ eventType: string; content: string; timestamp: string }>
        }>
      >
      /** Team chat (Stage 9). Absent in rooms created before this stage. */
      chatMessages?: LiveList<{
        id: string
        userId: string
        content: string
        timestamp: string
      }>
    }
  }
}

export {}
