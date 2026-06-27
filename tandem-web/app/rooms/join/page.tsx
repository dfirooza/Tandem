import Link from 'next/link'
import { joinRoom } from '@/app/rooms/actions'

export default async function JoinRoomPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main>
      <Link href="/rooms">← Back to rooms</Link>
      <h1>Join a room</h1>
      {error && <p className="error">{error}</p>}
      <form action={joinRoom}>
        <label>
          Invite code
          <input
            type="text"
            name="invite_code"
            required
            placeholder="e.g. ABC12345"
            style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}
          />
        </label>
        <button type="submit">Join room</button>
      </form>
    </main>
  )
}
