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
Stage 5 complete and verified end-to-end. Any room member can branch 
from any point in any session (their own or a teammate's) via a 
server-verified POST /branch endpoint on tandem-server. Branches copy 
events from Supabase (durable source of truth) up to the click point, 
seed the corresponding Liveblocks storage, and show a lineage label. 
Original sessions are unaffected. Branches are static copies for now — 
live continuation of a branch (attaching a new tandem claude process to 
continue a branched session) is a known follow-up, not yet built. 
Confirmed with 11/11 branch e2e tests plus manual browser verification 
by two real users, including cross-owner branching, source-session 
integrity, and durability across page refresh.
Next: Stage 6 — project memory (pin decisions, tag context, inject 
relevant memory into new tandem claude sessions automatically).

## Rules for any AI assistant working in this repo
- Stay within the current stage's scope. Do not implement future-stage 
  features "while you're at it."
- Do not introduce new services/libraries not listed above without 
  flagging it first.
- Ask before making architectural decisions not already specified here.