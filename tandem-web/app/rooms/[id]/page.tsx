import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { signOut } from '@/app/auth/actions'
import { pinMemory, deleteMemory } from './actions'
import LiveSessionSection, { RoomRealtime } from './live'
import ChatPanel from './chat'
import ControlSocketProvider from './control-socket'

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
    .select('id, user_id, status, parent_session_id, last_summary, last_summary_at')
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
    lastSummary: (s.last_summary as string | null) ?? null,
    lastSummaryAt: (s.last_summary_at as string | null) ?? null,
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

  // Chat history (Stage 9): durable messages via RLS; live updates arrive
  // through Liveblocks in the ChatPanel.
  const { data: chatRows } = await supabase
    .from('chat_messages')
    .select('id, user_id, content, created_at')
    .eq('room_id', id)
    .order('created_at', { ascending: true })

  const chatHistory = (chatRows ?? []).map((m) => ({
    id: m.id,
    userId: m.user_id,
    content: m.content,
    timestamp: m.created_at,
  }))

  return (
    <RoomRealtime roomId={room.id} selfEmail={user.email ?? user.id}>
      <ControlSocketProvider roomId={room.id} userId={user.id}>
      <div className="flex min-h-screen">
        <main className="min-w-0 flex-1 px-8 py-6">
          <header className="mb-6 flex items-center justify-between gap-4 border-b border-border pb-4">
        <div className="flex items-baseline gap-3">
          <h1 className="m-0">{room.name}</h1>
          <span className="code" title="Share this invite code with teammates">
            {room.invite_code}
          </span>
        </div>
        <form action={signOut}>
          <button type="submit" className="btn-ghost">
            Sign out
          </button>
        </form>
      </header>

      <h2 className="section-title mt-0">Members ({members?.length ?? 0})</h2>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {members?.map((m) => (
          <li
            key={m.user_id}
            className="rounded-md border border-border px-2 py-0.5 text-xs text-secondary"
          >
            {emailById[m.user_id] ?? m.user_id}
            {m.user_id === user.id && <span className="ml-1 text-muted">(you)</span>}
          </li>
        ))}
      </ul>

      <section>
        <h2 className="section-title">Project Memory</h2>
        <form action={pinMemoryForRoom} className="card mb-4 max-w-2xl space-y-2 p-3">
          <textarea
            name="content"
            required
            placeholder="Pin a decision, convention, or piece of context…"
            rows={3}
            className="input max-w-none resize-y"
          />
          <div className="flex items-center gap-2">
            <input
              name="tags"
              placeholder="tags, comma, separated (optional)"
              className="input mt-0 w-80 font-mono text-sm"
            />
            <button type="submit" className="btn-primary">
              Pin
            </button>
          </div>
        </form>

        {(memoryEntries ?? []).length === 0 ? (
          <p className="text-muted">No memory pinned yet.</p>
        ) : (
          <ul className="m-0 list-none space-y-2 p-0">
            {(memoryEntries ?? []).map((entry) => (
              <li key={entry.id} className="card max-w-2xl p-3">
                <p className="m-0 whitespace-pre-wrap text-[13px]">{entry.content}</p>
                <p className="mb-0 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  {(entry.tags ?? []).length > 0 && (
                    <span className="flex gap-1">
                      {(entry.tags as string[]).map((t) => (
                        <span key={t} className="code px-1.5 text-xs tracking-normal text-muted">
                          {t}
                        </span>
                      ))}
                    </span>
                  )}
                  <span>
                    pinned by {emailById[entry.pinned_by] ?? entry.pinned_by} ·{' '}
                    {new Date(entry.created_at).toLocaleString()}
                  </span>
                  {entry.pinned_by === user.id && (
                    <button
                      formAction={deleteMemory.bind(null, id, entry.id)}
                      form={`delete-${entry.id}`}
                      type="submit"
                      className="cursor-pointer rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs text-muted transition-colors hover:border-danger/40 hover:text-danger"
                    >
                      Delete
                    </button>
                  )}
                </p>
                {entry.pinned_by === user.id && <form id={`delete-${entry.id}`} />}
              </li>
            ))}
          </ul>
        )}
      </section>

          <LiveSessionSection
            emailById={emailById}
            historySessions={historySessions}
            ownerBySessionId={ownerBySessionId}
            selfId={user.id}
          />
        </main>

        <ChatPanel
          roomId={room.id}
          selfId={user.id}
          emailById={emailById}
          history={chatHistory}
        />
      </div>
      </ControlSocketProvider>
    </RoomRealtime>
  )
}
