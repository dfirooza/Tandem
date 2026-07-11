import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { signOut } from '@/app/auth/actions'
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
