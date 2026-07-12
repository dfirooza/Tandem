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
Stage 12 complete: room/endpoint visibility audit (found and fixed a 
real gap — CLI WebSocket auth wasn't checking room membership, only 
valid auth, meaning any signed-in user who knew a room UUID could join 
a session in it; now enforced and proven closed across all 
surfaces: rooms, sessions, memory, chat, activity, branch, control, 
and both WS auth paths — 21/21 e2e). History simplified per user 
feedback: only sessions/branches with a real summary appear, compact 
single-line rows (owner, time, summary, branch badge if applicable), 
with click-to-expand into the full raw content (expand was removed, 
then restored per follow-up feedback) — Live Sessions unaffected.
Next: in-terminal passive activity visibility, so users see teammate 
updates without switching to the browser (highest-priority remaining 
item from user feedback).

## Rules for any AI assistant working in this repo
- Stay within the current stage's scope. Do not implement future-stage 
  features "while you're at it."
- Do not introduce new services/libraries not listed above without 
  flagging it first.
- Ask before making architectural decisions not already specified here.