# Tandem — Architecture & Conventions

## What this is
Tandem is a multiplayer coordination layer for dev teams using AI coding 
agents. Users join a room, run `tandem claude` instead of `claude` directly, 
and teammates can see each other's live Claude Code sessions in the web app.

## Architecture (do not deviate without discussion)
- Supabase (Postgres) = durable source of truth. Users, rooms, room 
  membership, full session event history.
- Liveblocks = live/ephemeral layer only. Presence, cursors, and the 
  live representation of an active session. NOT a permanent database.
- tandem-server = the ONLY component that writes to Liveblocks. The CLI 
  never talks to Liveblocks directly — it sends events to tandem-server, 
  which writes to Supabase (durable) AND pushes to Liveblocks (live).
- tandem-cli wraps the real `claude` binary via node-pty (not 
  child_process.spawn — Claude Code needs a real PTY for interactive 
  behavior to work correctly).
- On Windows, tandem-cli spawns the target through `cmd.exe /c` because 
  npm-installed `claude` is a .cmd shim that ConPTY's CreateProcess 
  cannot resolve directly.

## Data model (Supabase)
- users (from Supabase Auth)
- rooms: id, name, created_by, invite_code, created_at
- room_members: room_id, user_id, joined_at
- sessions: id, room_id, user_id, parent_session_id (nullable, for future 
  branching), status, started_at, ended_at
- session_events: id, session_id, type, content, created_at

## Current stage
Stage 6 complete and verified end-to-end. Room members can pin memory 
entries via a new Project Memory panel; entries are stored durably in 
Supabase with RLS (any member can create, only the pinner can delete). 
tandem-cli fetches a room's pinned memory at startup and writes it to 
CLAUDE.md in a fresh directory (or TANDEM_MEMORY.md if CLAUDE.md already 
exists, never overwriting user files). Confirmed end-to-end: pinned a 
real memory entry, verified cross-account visibility and delete 
permissions, and confirmed a real Claude Code session in a fresh 
directory correctly cited the pinned memory content unprompted when 
asked "what do you know about this project?" — 13/13 memory e2e tests, 
all prior stage regressions still green (7/7, 5/5, 11/11).

ALL SIX ORIGINAL STAGES COMPLETE. Tandem now has: live multiplayer 
session visibility, presence and cursors, reconnect/resume with 
backfill, cross-owner branching, and persistent project memory injected 
into new sessions. 

Known follow-ups not yet built: visual design/styling (everything is 
functional but unstyled by design through all 6 stages), team chat 
(not in original scope), live continuation of a branched session, 
automatic/AI-driven memory extraction (currently manual pinning only).

## Rules for any AI assistant working in this repo
- Stay within the current stage's scope. Do not implement future-stage 
  features "while you're at it."
- Do not introduce new services/libraries not listed above without 
  flagging it first.
- Ask before making architectural decisions not already specified here.