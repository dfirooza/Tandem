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
Stage 4 complete and verified end-to-end. tandem-cli reconnects with 
exponential backoff on dropped connections, buffers output during 
outages and flushes on reconnect (new session semantics, no fake 
continuity). tandem-server has a ping/pong heartbeat to detect silent 
drops and an orphan-session sweep on boot. Room page shows static 
history panels for sessions with Supabase data but no Liveblocks state 
(backfill) — confirmed working in browser. Live presence cursors 
confirmed working across multiple browser tabs.
Next: Stage 5 — branching (fork a session at a point in time, diverge 
into a parallel session).

## Rules for any AI assistant working in this repo
- Stay within the current stage's scope. Do not implement future-stage 
  features "while you're at it."
- Do not introduce new services/libraries not listed above without 
  flagging it first.
- Ask before making architectural decisions not already specified here.