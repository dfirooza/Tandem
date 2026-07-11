import { joinRoom } from '@/app/rooms/actions'

export default async function JoinRoomPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main className="w-full max-w-sm px-8 py-10">
      <p className="eyebrow mb-2">Rooms</p>
      <h1 className="mb-4">Join a room</h1>
      {error && <p className="error">{error}</p>}
      <form action={joinRoom} className="space-y-4">
        <label>
          Invite code
          <input
            className="input font-mono uppercase tracking-[0.15em]"
            type="text"
            name="invite_code"
            required
            placeholder="e.g. ABC12345"
          />
        </label>
        <button type="submit" className="btn-primary">
          Join room
        </button>
      </form>
    </main>
  )
}
