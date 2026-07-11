-- Tandem — Stage 9: team chat
-- Human-to-human messages within a room, separate from AI session content.
-- Messages are permanent: no editing or deleting in this stage.
-- Run this in the Supabase SQL editor (after 002_memory_entries.sql).

CREATE TABLE IF NOT EXISTS chat_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content    text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Room members can read all chat messages in their room.
DROP POLICY IF EXISTS "Members can view room chat" ON chat_messages;
CREATE POLICY "Members can view room chat"
  ON chat_messages FOR SELECT TO authenticated
  USING ( is_room_member(room_id) );

-- Any room member can send a message, but only as themselves.
DROP POLICY IF EXISTS "Members can send room chat" ON chat_messages;
CREATE POLICY "Members can send room chat"
  ON chat_messages FOR INSERT TO authenticated
  WITH CHECK ( is_room_member(room_id) AND user_id = auth.uid() );

-- No UPDATE or DELETE policies: messages are permanent once sent.

-- Table privileges (RLS above scopes the rows).
GRANT SELECT, INSERT ON chat_messages TO authenticated;
GRANT ALL ON chat_messages TO service_role;
