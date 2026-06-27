import Link from 'next/link'
import { createRoom } from '@/app/rooms/actions'

export default async function CreateRoomPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main>
      <Link href="/rooms">← Back to rooms</Link>
      <h1>Create a room</h1>
      {error && <p className="error">{error}</p>}
      <form action={createRoom}>
        <label>
          Room name
          <input type="text" name="name" required placeholder="e.g. backend squad" />
        </label>
        <button type="submit">Create room</button>
      </form>
    </main>
  )
}
