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
Stage 13 complete: in-terminal passive activity visibility. Part A — a 
persistent status bar reserved at the top of the terminal while tandem 
claude runs beneath it: DECSTBM scroll region excludes the top rows, 
the wrapped Claude Code process is told the reduced height (real rows 
minus reserved) at spawn and on every resize, and the terminal's full 
scroll region + reserved rows are restored on every exit path (normal, 
Ctrl+C, SIGTERM, SIGHUP, uncaught). Auto-disables on non-TTY stdout, 
terminals under 15 rows, or TANDEM_NO_STATUS_BAR; fetches room activity 
every 15s and shows offline rather than stale on failure. Part B — a 
one-shot `tandem status [--room <id>]` command that fetches activity + 
summary-only history and prints, no PTY or persistent connection. New 
GET /rooms/:roomId/history endpoint (membership-checked). Terminal 
escape-sequence contract (region set, resize re-apply, restore on all 
four exit paths) covered by an automated PTY-level test; the visual bar 
itself is a manual check. Confirmed live: tandem status against a real 
server, and session mode unregressed in non-TTY.
Fixed post-verification: intermittent status bar flicker, caused by the 
bar's periodic redraw using the terminal's single shared cursor 
save/restore register (DECSC/DECRC, \x1b7/\x1b8) — when that redraw 
landed between Claude Code's own cursor-save and cursor-restore (which 
span multiple output chunks) it clobbered Claude's saved position, so 
Claude's restore mis-placed the cursor and its next output painted over 
the reserved rows; and because the bar only redrew on the 15s fetch 
interval, it stayed gone for seconds. Fixed by repainting promptly 
(throttled ~200ms) on Claude output so the bar heals in milliseconds 
instead of seconds, re-asserting the scroll region on every draw, and 
wrapping each draw in DEC synchronized output as a single atomic write. 
Root cause proven and both fixes covered by regression tests (26/26).

## Performance fix (post Stage 13)
Fixed severe live-path latency: measured a 20-event burst backlog of 
~13.5s (durable-write-gated live path + per-event serialized cloud 
round-trips) down to ~0.46s. Fixes: (1) Supabase and Liveblocks writes 
now fire concurrently instead of sequentially, (2) PTY chunks batch 
into a single Liveblocks/Supabase write per ~40ms window instead of one 
cloud round-trip per chunk, (3) cold-start Liveblocks room setup moved 
to background so auth_ok returns immediately (~3.3s -> ~600ms). A real 
race condition surfaced during this work — backgrounding the cold-start 
write created concurrent unserialized writes to the same room's 
Liveblocks storage, causing a lost-update bug that silently wiped 
pending control requests (Stage 10 went flaky, 23/24). Fixed with 
per-room write serialization (a promise-chain ensuring all 8 
mutateStorage call sites for a given room never race each other) — 
confirmed with 4 consecutive clean runs of the control test suite. All 
9 stage regression suites green post-fix. TANDEM_PERF env-gated timing 
instrumentation left in place for future diagnostics (off by default).

## Rules for any AI assistant working in this repo
- Stay within the current stage's scope. Do not implement future-stage 
  features "while you're at it."
- Do not introduce new services/libraries not listed above without 
  flagging it first.
- Ask before making architectural decisions not already specified here.