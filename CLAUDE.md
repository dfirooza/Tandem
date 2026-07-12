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
Stage 11 complete: auto-summarized shared context. Active sessions with 
new activity get summarized by Claude Haiku every 45s (one global 
interval + per-session state map, no per-session timers to leak — 
entry absence is the stop signal). Summaries are concrete and accurate 
(verified: correctly captured specific technical detail from real 
session content, not generic filler). Room view defaults to a compact 
"who's doing what" list (pulsing status, live summary, relative time) 
with click-to-expand into the full session panel. tandem-cli now injects 
a "Currently active in this room" section into generated CLAUDE.md 
alongside pinned memory — confirmed end-to-end: a fresh Claude Code 
session in an empty directory correctly answered "what is my team 
currently working on?" by citing a teammate's real, live session 
summary, with zero manual input. Idle sessions are skipped (no wasted 
API calls), and summarization timers verified to stop within one 
interval of session end. Debug call counter at GET /debug/summaries.

ALL STAGES FROM THE ORIGINAL 6-STAGE PLAN PLUS FOLLOW-ON STAGES 7-11 
ARE COMPLETE. Tandem now has: live multiplayer session visibility with 
presence and cursors, reconnect/resume with backfill, cross-owner 
branching, persistent pinned memory, a full sidebar-shell UI in a 
monochrome+blue design direction, team chat, security-verified 
turn-based remote session control via xterm.js, and live AI-generated 
shared context that new sessions automatically receive.

Known follow-ups, not yet built: live continuation of a branched session, 
browser terminal size sync to PTY dimensions (cosmetic), any real users 
beyond the founder testing solo.

## Rules for any AI assistant working in this repo
- Stay within the current stage's scope. Do not implement future-stage 
  features "while you're at it."
- Do not introduce new services/libraries not listed above without 
  flagging it first.
- Ask before making architectural decisions not already specified here.