-- Tandem — Stage 6: project memory
-- Room members pin free-text memory entries (with optional tags) that
-- persist across sessions. tandem-cli fetches these at startup and writes
-- them into a local context file for Claude Code.
-- Run this in the Supabase SQL editor (after 001_initial_schema.sql).

CREATE TABLE IF NOT EXISTS memory_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  content    text NOT NULL,
  tags       text[] NOT NULL DEFAULT '{}',
  pinned_by  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE memory_entries ENABLE ROW LEVEL SECURITY;

-- Room members can read all memory entries in their room.
DROP POLICY IF EXISTS "Members can view room memory" ON memory_entries;
CREATE POLICY "Members can view room memory"
  ON memory_entries FOR SELECT TO authenticated
  USING ( is_room_member(room_id) );

-- Any room member can pin an entry, but only as themselves.
DROP POLICY IF EXISTS "Members can pin room memory" ON memory_entries;
CREATE POLICY "Members can pin room memory"
  ON memory_entries FOR INSERT TO authenticated
  WITH CHECK ( is_room_member(room_id) AND pinned_by = auth.uid() );

-- Only the user who pinned an entry can delete it (no admin roles).
DROP POLICY IF EXISTS "Users can delete their own memory entries" ON memory_entries;
CREATE POLICY "Users can delete their own memory entries"
  ON memory_entries FOR DELETE TO authenticated
  USING ( pinned_by = auth.uid() );

-- Table privileges (RLS above scopes the rows).
GRANT SELECT, INSERT, DELETE ON memory_entries TO authenticated;
GRANT ALL ON memory_entries TO service_role;
