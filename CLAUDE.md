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
Stage 10 complete: turn-based remote session control. Any room member 
can request control of a teammate's active session; the owner (if 
present in the room) approves or denies via a 30s-timeout prompt. Once 
granted, the controller gets real keystroke-level control through an 
embedded xterm.js terminal, with input routed browser -> tandem-server 
-> the owner's tandem-cli -> their local PTY. Control state lives only 
in server memory (never Liveblocks, never trusted from client claims) 
and is re-verified on every single input message. The owner's local 
terminal stdin always works regardless of control state; the web panel's 
input path is exclusively locked to whoever holds control. Auto-releases 
on disconnect, CLI drop, timeout, deny, or explicit revoke. 24/24 e2e 
tests including 4 dedicated security checks, all confirmed by the user 
directly with two real accounts (request, approve, remote typing 
reaching the real terminal, and the owner's web-panel input correctly 
blocked while someone else controls). Known limitation: browser terminal 
size is not synced to the owner's PTY dimensions (cosmetic, follow-up).
Next: auto-summarized shared context + compact UI redesign — the last 
remaining item from the user's Jul 10 feature list.

## Rules for any AI assistant working in this repo
- Stay within the current stage's scope. Do not implement future-stage 
  features "while you're at it."
- Do not introduce new services/libraries not listed above without 
  flagging it first.
- Ask before making architectural decisions not already specified here.