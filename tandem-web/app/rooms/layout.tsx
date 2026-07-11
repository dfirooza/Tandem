import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { signOut } from '@/app/auth/actions'
import Sidebar from './sidebar'

// App shell for all authenticated routes (everything lives under /rooms).
// Fetches the user's rooms for the sidebar the same way the old /rooms list
// page did; per-route content renders in the main area to the right.
export default async function RoomsLayout({
  children,
}: {
  children: React.ReactNode
}) {
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
    ? await supabase.from('rooms').select('id, name').in('id', roomIds)
    : { data: [] }

  // Re-order rooms to match membership order (most recently joined first)
  const orderMap = Object.fromEntries(roomIds.map((id, i) => [id, i]))
  const sortedRooms = (rooms ?? []).sort((a, b) => orderMap[a.id] - orderMap[b.id])

  return (
    <div className="flex min-h-screen">
      <Sidebar rooms={sortedRooms} email={user.email ?? user.id} signOut={signOut} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
