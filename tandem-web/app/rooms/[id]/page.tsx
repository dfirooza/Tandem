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
      />
    </main>
  )
}
