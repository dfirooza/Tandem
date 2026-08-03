# Tandem

A multiplayer coordination layer for dev teams using AI coding agents.

You join a room, run `tandem claude` instead of `claude`, and your teammates
see your live Claude Code session in the web app — alongside shared project
memory, team chat, and the ability to request control of a running session.

---

## How it works

Three components, plus two managed services:

```
  tandem-cli  ──WebSocket──▶  tandem-server  ──▶  Supabase   (durable truth)
 (wraps claude)                    │
                                   └──────────▶  Liveblocks (live layer)
                                                      │
  tandem-web  ◀──────────────────────────────────────┘
```

- **Supabase (Postgres)** is the durable source of truth: users, rooms,
  membership, and full session event history.
- **Liveblocks** is the live/ephemeral layer only — presence, cursors, and the
  live representation of an active session. It is not a database.
- **tandem-server** is the **only** component that writes to Liveblocks. The
  CLI never talks to Liveblocks directly; it sends events to tandem-server,
  which writes to Supabase and pushes to Liveblocks.
- **tandem-cli** wraps the real `claude` binary in a PTY (via `node-pty`, not
  `child_process.spawn` — Claude Code needs a real PTY to behave correctly).

### Repo layout

| Path | What it is |
|---|---|
| `tandem-cli/` | Terminal wrapper around `claude`. Publishes the `tandem` binary. |
| `tandem-server/` | WebSocket + HTTP server. Sole writer to Supabase and Liveblocks. |
| `tandem-web/` | Next.js app — rooms, live sessions, chat, project memory. |
| `supabase/migrations/` | SQL schema, run in order. |

---

## Setup

### Prerequisites

- **Node 22+** for `tandem-server` (required for Supabase realtime WebSocket
  support). Node 18+ is enough for `tandem-cli`.
- A **Supabase** project, a **Liveblocks** project, and — optionally — an
  **Anthropic API key** for session summarization.
- Claude Code installed and on your `PATH`.

### 1. Database

Run the migrations in `supabase/migrations/` **in numeric order** in the
Supabase SQL editor:

```
001_initial_schema.sql     users/profiles, rooms, room_members, sessions, session_events
002_memory_entries.sql     project memory
003_chat_messages.sql      team chat
004_session_summaries.sql  session summaries
```

### 2. Configure

Each package ships a template — copy it and fill in real values. None of these
files are committed.

```bash
cp tandem-server/.env.example  tandem-server/.env
cp tandem-web/.env.local.example tandem-web/.env.local
```

### 3. Install and run

```bash
# server
cd tandem-server && npm install && npm run build && npm start   # :8787

# web
cd tandem-web && npm install && npm run dev                     # :3000

# cli — `npm link` puts the `tandem` binary on your PATH
cd tandem-cli && npm install && npm run build && npm link
```

---

## Using the CLI

The CLI is configured entirely through environment variables — there is no
config file, and no default server URL. All three of these are required:

```bash
TANDEM_SERVER_URL=ws://localhost:8787 \
TANDEM_ROOM_ID=<room-uuid> \
TANDEM_USER_TOKEN=<supabase-access-token> \
tandem claude
```

Point it at a deployed server by using the `wss://` scheme — the HTTP endpoints
are derived from the same variable (`wss://` → `https://`), so there is only
one value to change.

A fresh access token can be minted with:

```bash
node tandem-server/scripts/get-token.mjs <email> <password>
```

Note that it reads `SUPABASE_URL` / `SUPABASE_ANON_KEY` from
`tandem-server/.env`, so it issues tokens for whichever project that file
points at.

### Commands

| Command | What it does |
|---|---|
| `tandem <cmd> [args…]` | Runs `<cmd>` in a PTY and streams the session to your room. Normally `tandem claude`. |
| `tandem status [--room <id>]` | One-shot print of room activity and history. No PTY, no persistent connection — safe to run alongside an active session. |

While a session runs, a status bar is reserved at the top of the terminal
showing room activity. It auto-disables on non-TTY output, terminals under 15
rows, or with `TANDEM_NO_STATUS_BAR` set.

---

## Environment variables

### tandem-cli

| Variable | Required | Notes |
|---|---|---|
| `TANDEM_SERVER_URL` | yes | `ws://` or `wss://`. HTTP calls derive from it. |
| `TANDEM_ROOM_ID` | yes | Room UUID. `tandem status --room` overrides it. |
| `TANDEM_USER_TOKEN` | yes | Supabase access token (short-lived). |
| `TANDEM_NO_STATUS_BAR` | no | Set to disable the in-terminal status bar. |
| `TANDEM_STATUS_DEBUG` | no | Verbose status-bar diagnostics. |

### tandem-server

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no | Defaults to `8787`. |
| `SUPABASE_URL` | yes | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Bypasses RLS. Never expose to clients. |
| `SUPABASE_ANON_KEY` | yes | Used by `scripts/get-token.mjs`. |
| `LIVEBLOCKS_SECRET_KEY` | no | If unset, runs without the live layer; Supabase writes still work. |
| `ANTHROPIC_API_KEY` | no | If unset, session summarization is disabled; everything else works. |
| `SUMMARY_INTERVAL_MS` | no | Summarization tick. Default `45000`. |
| `SUMMARY_MAX_PER_SESSION` | no | Per-session cap on summarization calls. Default `40` (~30 min of continuous activity). |
| `CONTROL_REQUEST_TIMEOUT_MS` | no | How long a pending control request stands. |
| `TANDEM_FLUSH_MS` | no | PTY-chunk batching window. |
| `TANDEM_PERF` | no | Enables timing instrumentation. Off by default. |

### tandem-web

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | |
| `NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY` | Browser-safe; reads the live session feed. |
| `TANDEM_SERVER_URL` | Server-side only. Used by server actions relaying to tandem-server. |
| `NEXT_PUBLIC_TANDEM_SERVER_URL` | `ws://`/`wss://`. Browser control socket. Every message is re-verified server-side. |

> When deploying the web app, `TANDEM_SERVER_URL` must point at a **publicly
> reachable** tandem-server. Server actions run on the host, not in the
> browser, so a `localhost` value resolves to the host itself and every call
> fails.

---

## Tests

The `tandem-server` suites are end-to-end: they need a **running server** and
real Supabase/Liveblocks credentials, and they exercise the real network path.

```bash
cd tandem-server
npm run build && npm start          # in one terminal
node test/e2e-stage9-chat.mjs       # in another
```

Set `TANDEM_TEST_PASSWORD` in `tandem-server/.env` first — the tests refuse to
run without it, deliberately, so a real password can never be hardcoded into a
test file.

The summarization suite wants a shorter tick than the default:

```bash
SUMMARY_INTERVAL_MS=3000 node dist/index.js
SUMMARY_INTERVAL_MS=3000 node test/e2e-stage11-summary.mjs
```

The CLI suite is self-contained and drives a real PTY:

```bash
cd tandem-cli && node test/statusbar.test.mjs
```

---

## Platform notes

On Windows, `tandem-cli` spawns the target through `cmd.exe /c`, because the
npm-installed `claude` is a `.cmd` shim that ConPTY's `CreateProcess` cannot
resolve directly.

---

## Conventions

The architecture above is deliberate, and two rules follow from it:

- **tandem-server is the only writer** to Liveblocks and to Supabase
  `sessions` / `session_events`. The CLI and the web app both relay through it.
- **Liveblocks is not a database.** Anything that must survive a reconnect
  belongs in Supabase.

Contributors — human or AI — should flag new services or libraries before
adding them, and raise architectural changes rather than making them inline.
See `CLAUDE.md` for the full working agreement.
