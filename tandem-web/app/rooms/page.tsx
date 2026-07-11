import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'

// Landing view inside the shell — the sidebar owns room navigation, so this
// is just a lightweight overview / empty state.
export default async function RoomsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { count } = await supabase
    .from('room_members')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)

  return (
    <main className="mx-auto w-full max-w-2xl px-8 py-10">
      <p className="eyebrow mb-2">Overview</p>
      <h1 className="mb-1">Welcome back</h1>
      <p className="mb-8 text-[13px] text-secondary">
        Signed in as {user.email}
        {typeof count === 'number' && (
          <span className="text-muted">
            {' '}
            · {count} room{count === 1 ? '' : 's'}
          </span>
        )}
      </p>

      {count ? (
        <p className="text-[13px] text-secondary">
          Pick a room from the sidebar to see its live sessions, project memory,
          and members.
        </p>
      ) : (
        <p className="text-[13px] text-secondary">
          No rooms yet — create one or join with an invite code.
        </p>
      )}

      <div className="mt-6 flex gap-2">
        <Link href="/rooms/create" className="btn-primary no-underline">
          + Create room
        </Link>
        <Link href="/rooms/join" className="btn-ghost no-underline">
          Join room
        </Link>
      </div>
    </main>
  )
}
