'use server'

import { createClient } from '@/lib/supabase/server'

// Branching is executed by tandem-server (the only writer to Supabase
// sessions/events and Liveblocks); this action just relays the request
// with the user's access token so tandem-server can verify who clicked.
export async function branchSession(
  sourceSessionId: string,
  eventCount: number
): Promise<{ sessionId?: string; error?: string }> {
  const supabase = await createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return { error: 'not signed in' }

  const base = process.env.TANDEM_SERVER_URL ?? 'http://localhost:8787'
  try {
    const res = await fetch(`${base}/branch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
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
