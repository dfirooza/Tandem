import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { signOut } from '@/app/auth/actions'
import { pinMemory, deleteMemory } from './actions'
import LiveSessionSection from './live'

export default async function RoomPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Fetch room (RLS ensures the user is a member or creator)
  const { data: room } = await supabase
    .from('rooms')
    .select('id, name, invite_code')
    .eq('id', id)
    .single()

  if (!room) notFound()

  // Fetch members and their emails from profiles
  const { data: members } = await supabase
    .from('room_members')
    .select('user_id, joined_at')
    .eq('room_id', id)
    .order('joined_at', { ascending: true })

  const memberIds = members?.map((m) => m.user_id) ?? []

  const { data: profileRows } = memberIds.length
    ? await supabase.from('profiles').select('id, email').in('id', memberIds)
    : { data: [] }

  const emailById = Object.fromEntries((profileRows ?? []).map((p) => [p.id, p.email]))

  // Durable session history for the late-joiner backfill: if Liveblocks
  // storage is missing a session's events, the client falls back to this.
  // Events are kept per-event (not joined) so each one can host a
  // "branch from here" target.
  const { data: dbSessions } = await supabase
    .from('sessions')
    .select('id, user_id, status, parent_session_id')
    .eq('room_id', id)
    .order('started_at', { ascending: true })

  const dbSessionIds = dbSessions?.map((s) => s.id) ?? []
  const { data: dbEvents } = dbSessionIds.length
    ? await supabase
        .from('session_events')
        .select('session_id, content')
        .in('session_id', dbSessionIds)
        .order('created_at', { ascending: true })
    : { data: [] }

  const eventsBySession: Record<string, { content: string }[]> = {}
  for (const e of dbEvents ?? []) {
    ;(eventsBySession[e.session_id] ??= []).push({ content: e.content ?? '' })
  }
  const historySessions = (dbSessions ?? []).map((s) => ({
    sessionId: s.id,
    userId: s.user_id,
    status: s.status,
    parentSessionId: s.parent_session_id as string | null,
    events: eventsBySession[s.id] ?? [],
  }))

  // sessionId -> owner userId for every session in the room, so branched
  // panels can label their parent's owner.
  const ownerBySessionId = Object.fromEntries(
    (dbSessions ?? []).map((s) => [s.id, s.user_id])
  )

  // Project memory (Stage 6): reads via RLS; pin/delete go through
  // tandem-server (see actions.ts).
  const { data: memoryEntries } = await supabase
    .from('memory_entries')
    .select('id, content, tags, pinned_by, created_at')
    .eq('room_id', id)
    .order('created_at', { ascending: false })

  const pinMemoryForRoom = pinMemory.bind(null, id)

  return (
    <main>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link href="/rooms">← Rooms</Link>
        <form action={signOut}>
          <button type="submit">Sign out</button>
        </form>
      </header>

      <h1>{room.name}</h1>
      <p>
        Invite code:{' '}
        <span className="code">{room.invite_code}</span>
        <span style={{ color: '#555', fontSize: '0.875rem', marginLeft: '0.5rem' }}>
          (share this with teammates)
        </span>
      </p>

      <h2>Members ({members?.length ?? 0})</h2>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {members?.map((m) => (
          <li key={m.user_id} style={{ padding: '0.25rem 0' }}>
            {emailById[m.user_id] ?? m.user_id}
            {m.user_id === user.id && (
              <span style={{ color: '#555', fontSize: '0.875rem', marginLeft: '0.4rem' }}>(you)</span>
            )}
          </li>
        ))}
      </ul>

      <section>
        <h2>Project Memory</h2>
        <form action={pinMemoryForRoom} style={{ marginBottom: '1rem' }}>
          <textarea
            name="content"
            required
            placeholder="Pin a decision, convention, or piece of context…"
            rows={3}
            style={{ display: 'block', width: '100%', maxWidth: '40rem' }}
          />
          <input
            name="tags"
            placeholder="tags, comma, separated (optional)"
            style={{ margin: '0.5rem 0.5rem 0 0', width: '20rem' }}
          />
          <button type="submit">Pin</button>
        </form>

        {(memoryEntries ?? []).length === 0 ? (
          <p style={{ color: '#555' }}>No memory pinned yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {(memoryEntries ?? []).map((entry) => (
              <li
                key={entry.id}
                style={{
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  padding: '0.5rem',
                  marginBottom: '0.5rem',
                }}
              >
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{entry.content}</p>
                <p style={{ margin: '0.25rem 0 0', color: '#555', fontSize: '0.8rem' }}>
                  {(entry.tags ?? []).length > 0 && (
                    <span>
                      {(entry.tags as string[]).map((t) => (
                        <span
                          key={t}
                          className="code"
                          style={{ marginRight: '0.3rem', fontSize: '0.75rem' }}
                        >
                          {t}
                        </span>
                      ))}
                      {' · '}
                    </span>
                  )}
                  pinned by {emailById[entry.pinned_by] ?? entry.pinned_by} ·{' '}
                  {new Date(entry.created_at).toLocaleString()}
                  {entry.pinned_by === user.id && (
                    <>
                      {' · '}
                      <button
                        formAction={deleteMemory.bind(null, id, entry.id)}
                        form={`delete-${entry.id}`}
                        type="submit"
                        style={{ fontSize: '0.75rem' }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </p>
                {entry.pinned_by === user.id && <form id={`delete-${entry.id}`} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <LiveSessionSection
        roomId={room.id}
        selfEmail={user.email ?? user.id}
        emailById={emailById}
        historySessions={historySessions}
        ownerBySessionId={ownerBySessionId}
      />
    </main>
  )
}
