'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

const TANDEM_SERVER = () => process.env.TANDEM_SERVER_URL ?? 'http://localhost:8787'

async function accessToken(): Promise<string | null> {
  const supabase = await createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return session?.access_token ?? null
}

// Branching is executed by tandem-server (the only writer to Supabase
// sessions/events and Liveblocks); this action just relays the request
// with the user's access token so tandem-server can verify who clicked.
export async function branchSession(
  sourceSessionId: string,
  eventCount: number
): Promise<{ sessionId?: string; error?: string }> {
  const token = await accessToken()
  if (!token) return { error: 'not signed in' }

  try {
    const res = await fetch(`${TANDEM_SERVER()}/branch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sourceSessionId, eventCount }),
    })
    const json = (await res.json().catch(() => ({}))) as {
      sessionId?: string
      error?: string
    }
    if (!res.ok) return { error: json.error ?? `tandem-server returned ${res.status}` }
    return { sessionId: json.sessionId }
  } catch {
    return { error: 'could not reach tandem-server — is it running?' }
  }
}

// ─── Project memory (Stage 6) ────────────────────────────────────────────────
// Reads happen in the page via RLS; writes go through tandem-server's
// memory endpoints (same relay pattern as branching).

export async function pinMemory(roomId: string, formData: FormData) {
  const token = await accessToken()
  if (!token) return

  const content = ((formData.get('content') as string) ?? '').trim()
  if (!content) return
  const tags = ((formData.get('tags') as string) ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  try {
    await fetch(`${TANDEM_SERVER()}/rooms/${roomId}/memory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ content, tags }),
    })
  } catch {
    // tandem-server unreachable; the page re-render will show nothing changed.
  }
  revalidatePath(`/rooms/${roomId}`)
}

// ─── Remote session control (Stage 10) ───────────────────────────────────────
// All four verbs relay to tandem-server, which is the sole authority on
// control state. The input path itself is a browser WebSocket (see
// control-socket.tsx) — these actions only manage grants.

async function controlAction(
  sessionId: string,
  action: 'request' | 'approve' | 'deny' | 'release'
): Promise<{ ok?: true; error?: string }> {
  const token = await accessToken()
  if (!token) return { error: 'not signed in' }

  try {
    const res = await fetch(
      `${TANDEM_SERVER()}/sessions/${sessionId}/control/${action}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
    )
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) return { error: json.error ?? `tandem-server returned ${res.status}` }
    return { ok: true }
  } catch {
    return { error: 'could not reach tandem-server — is it running?' }
  }
}

export async function requestControl(sessionId: string) {
  return controlAction(sessionId, 'request')
}
export async function approveControl(sessionId: string) {
  return controlAction(sessionId, 'approve')
}
export async function denyControl(sessionId: string) {
  return controlAction(sessionId, 'deny')
}
export async function releaseControl(sessionId: string) {
  return controlAction(sessionId, 'release')
}

// ─── Team chat (Stage 9) ─────────────────────────────────────────────────────
// Same relay pattern: tandem-server does the durable insert + Liveblocks
// mirror. No revalidate needed — the message arrives live via Liveblocks.

export async function sendChatMessage(
  roomId: string,
  content: string
): Promise<{ ok?: true; error?: string }> {
  const token = await accessToken()
  if (!token) return { error: 'not signed in' }

  try {
    const res = await fetch(`${TANDEM_SERVER()}/rooms/${roomId}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ content }),
    })
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) return { error: json.error ?? `tandem-server returned ${res.status}` }
    return { ok: true }
  } catch (err) {
    // TEMPORARY debug — remove once the chat send failure is diagnosed.
    console.error('[tandem debug] sendChatMessage fetch failed', {
      TANDEM_SERVER_URL: process.env.TANDEM_SERVER_URL,
      error: err,
    })
    return { error: 'could not reach tandem-server — is it running?' }
  }
}

export async function deleteMemory(roomId: string, entryId: string) {
  const token = await accessToken()
  if (!token) return

  try {
    await fetch(`${TANDEM_SERVER()}/rooms/${roomId}/memory/${entryId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    // tandem-server unreachable; nothing to do.
  }
  revalidatePath(`/rooms/${roomId}`)
}
