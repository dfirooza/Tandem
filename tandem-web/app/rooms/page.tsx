import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { signOut } from '@/app/auth/actions'

export default async function RoomsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: memberships } = await supabase
    .from('room_members')
    .select('room_id, joined_at')
    .eq('user_id', user.id)
    .order('joined_at', { ascending: false })

  const roomIds = memberships?.map((m) => m.room_id) ?? []

  const { data: rooms } = roomIds.length
    ? await supabase
        .from('rooms')
        .select('id, name, invite_code')
        .in('id', roomIds)
    : { data: [] }

  // Re-order rooms to match membership order (most recently joined first)
  const orderMap = Object.fromEntries(roomIds.map((id, i) => [id, i]))
  const sortedRooms = (rooms ?? []).sort((a, b) => orderMap[a.id] - orderMap[b.id])

  return (
    <main>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Tandem</h1>
        <form action={signOut}>
          <button type="submit">Sign out</button>
        </form>
      </header>
      <p style={{ color: '#555' }}>Signed in as {user.email}</p>

      <nav>
        <Link href="/rooms/create">+ Create room</Link>
        <Link href="/rooms/join">Join room</Link>
      </nav>

      <h2>Your rooms</h2>
      {sortedRooms.length === 0 ? (
        <p>No rooms yet. Create one or join with an invite code.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {sortedRooms.map((room) => (
            <li key={room.id} style={{ marginBottom: '0.5rem' }}>
              <Link href={`/rooms/${room.id}`}>{room.name}</Link>
              <span style={{ color: '#888', marginLeft: '0.5rem', fontSize: '0.875rem' }}>
                code: <span className="code">{room.invite_code}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
