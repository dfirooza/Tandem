'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Persistent app-shell sidebar. Pure presentation: rooms are fetched by the
// server layout and passed in; signOut is the existing server action.
// (A future chat panel would slot in as a sibling of the main content area,
// not here — this stays navigation-only.)
export default function Sidebar({
  rooms,
  email,
  signOut,
}: {
  rooms: { id: string; name: string }[]
  email: string
  signOut: () => Promise<void>
}) {
  const pathname = usePathname()

  return (
    <aside className="sticky top-0 flex h-screen w-48 shrink-0 flex-col border-r border-border bg-sidebar">
      <Link
        href="/rooms"
        className="block px-4 pb-3 pt-4 font-mono text-xs font-semibold tracking-[0.25em] text-foreground no-underline hover:text-foreground"
      >
        TANDEM
      </Link>

      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="eyebrow">Rooms</span>
        <span className="flex items-center gap-2 text-[11px]">
          <Link href="/rooms/create" title="Create room" className="no-underline">
            + new
          </Link>
          <Link href="/rooms/join" title="Join room" className="no-underline">
            join
          </Link>
        </span>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-1">
        {rooms.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted">No rooms yet</p>
        ) : (
          rooms.map((room) => {
            const active = pathname === `/rooms/${room.id}`
            return (
              <Link
                key={room.id}
                href={`/rooms/${room.id}`}
                className={`block truncate rounded-md border-l-2 py-1.5 pl-2.5 pr-2 text-[13px] no-underline transition-colors ${
                  active
                    ? 'border-accent bg-surface-hover text-foreground'
                    : 'border-transparent text-secondary hover:bg-surface-hover hover:text-foreground'
                }`}
              >
                {room.name}
              </Link>
            )
          })
        )}
      </nav>

      <div className="border-t border-border p-3">
        <p className="mb-2 truncate text-[11px] text-muted" title={email}>
          {email}
        </p>
        <form action={signOut}>
          <button
            type="submit"
            className="btn-ghost w-full justify-center px-2 py-1 text-xs"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  )
}
