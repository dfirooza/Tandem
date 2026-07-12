-- Tandem — Stage 11: auto-summarized shared context
-- tandem-server periodically summarizes active sessions with Claude Haiku;
-- the result is stored here (durable) and mirrored to Liveblocks (live UI).
-- Run this in the Supabase SQL editor (after 003_chat_messages.sql).

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_summary text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_summary_at timestamptz;
