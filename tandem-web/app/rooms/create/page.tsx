import { createRoom } from '@/app/rooms/actions'

export default async function CreateRoomPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main className="w-full max-w-sm px-8 py-10">
      <p className="eyebrow mb-2">Rooms</p>
      <h1 className="mb-4">Create a room</h1>
      {error && <p className="error">{error}</p>}
      <form action={createRoom} className="space-y-4">
        <label>
          Room name
          <input
            className="input"
            type="text"
            name="name"
            required
            placeholder="e.g. backend squad"
          />
        </label>
        <button type="submit" className="btn-primary">
          Create room
        </button>
      </form>
    </main>
  )
}
