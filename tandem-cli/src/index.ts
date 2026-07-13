#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as pty from "node-pty";
import stripAnsi from "strip-ansi";
import WebSocket from "ws";
import {
  STATUS_ROWS,
  scrollRegionSeq,
  barUpdateSeq,
  restoreSeq,
  registerExitHandlers,
} from "./statusbar.js";

interface CapturedChunk {
  /** Raw PTY output, ANSI escape codes intact. */
  raw: string;
  /** Same chunk with ANSI codes removed, for readability. */
  stripped: string;
  timestamp: number;
}

const [command, ...commandArgs] = process.argv.slice(2);

if (!command) {
  process.stderr.write("Usage: tandem <command> [args...]\n");
  process.stderr.write("       tandem status [--room <roomId>]\n");
  process.stderr.write("Example: tandem claude\n");
  process.exit(1);
}

/** True when running the `tandem status` subcommand — a one-shot fetch-and-
    print, no WebSocket, no PTY, safe to run alongside an active session. */
const isStatusMode = command === "status";

// ─── Tandem server connection config ─────────────────────────────────────────

const serverUrl = process.env.TANDEM_SERVER_URL;
// `tandem status --room <id>` overrides the env room (same context pattern
// as everything else: TANDEM_ROOM_ID by default).
const roomFlagIndex = commandArgs.indexOf("--room");
const roomId =
  isStatusMode && roomFlagIndex !== -1 && commandArgs[roomFlagIndex + 1]
    ? commandArgs[roomFlagIndex + 1]
    : process.env.TANDEM_ROOM_ID;
const userToken = process.env.TANDEM_USER_TOKEN;

const missing = [
  !serverUrl && "TANDEM_SERVER_URL",
  !roomId && "TANDEM_ROOM_ID",
  !userToken && "TANDEM_USER_TOKEN",
].filter(Boolean);
if (missing.length > 0) {
  process.stderr.write(
    `[tandem] Missing required environment variables: ${missing.join(", ")}\n` +
      `[tandem] Set them and retry. Example:\n` +
      `[tandem]   TANDEM_SERVER_URL=ws://localhost:8787\n` +
      `[tandem]   TANDEM_ROOM_ID=<room uuid>\n` +
      `[tandem]   TANDEM_USER_TOKEN=<Supabase access token>\n`
  );
  process.exit(1);
}

/**
 * Extract the user id (`sub` claim) from the Supabase JWT for the auth
 * message. No verification here — the server verifies the token properly
 * via Supabase auth.getUser().
 */
function userIdFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

const userId = userIdFromToken(userToken!);
if (!userId) {
  process.stderr.write(
    "[tandem] TANDEM_USER_TOKEN does not look like a valid JWT (could not " +
      "read user id from it).\n"
  );
  process.exit(1);
}

// ─── WebSocket client ────────────────────────────────────────────────────────
// Streams captured output to tandem-server in real time. Connection problems
// must never interrupt the Claude Code session: on an unexpected drop we warn
// on stderr and keep reconnecting in the background with exponential backoff,
// indefinitely, for as long as the wrapped process is running. The server does
// not resume sessions, so a successful reconnect starts a NEW session — we say
// so on stderr rather than faking continuity.

type WireState = "connecting" | "ready" | "reconnecting" | "dead";
let wireState: WireState = "connecting";
let sessionId: string | null = null;
/** True once any session was established — distinguishes reconnects. */
let everHadSession = false;
/** True once we start our own graceful shutdown — stops reconnecting. */
let shuttingDown = false;

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let backoffMs = 1_000;
const MAX_BACKOFF_MS = 30_000;

// Chunks captured while no session is ready (before the first auth_ok, or
// mid-reconnect), flushed into the (new) session once one is established.
// Bounded so an extended outage cannot grow memory without limit.
const MAX_PENDING_EVENTS = 5_000;
const pendingEvents: { content: string; raw: string; timestamp: string }[] = [];

// Remote input sink (Stage 10): the server forwards { type: "input" }
// messages when a room member has been granted control of this session.
// The server is the trusted source — it verifies the actual sender's
// identity against the current controller before forwarding anything, so
// the CLI writes input to the PTY exactly as if it were local stdin.
let remoteInput: ((data: string) => void) | null = null;

// Application close codes from tandem-server that a retry cannot fix
// (bad/expired token, protocol violation). Retrying would just loop.
const FATAL_CLOSE_CODES = new Set([4001, 4002]);

function goDead(message: string) {
  wireState = "dead";
  ws = null;
  pendingEvents.length = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (!shuttingDown) {
    process.stderr.write(
      `\n[tandem] ${message} Session continues locally; events are no ` +
        `longer being sent.\n`
    );
  }
}

function connect() {
  reconnectTimer = null;
  if (shuttingDown || wireState === "dead") return;

  let socket: WebSocket;
  try {
    socket = new WebSocket(serverUrl!);
  } catch (err) {
    handleDrop(null, err instanceof Error ? err.message : String(err));
    return;
  }
  ws = socket;

  socket.on("open", () => {
    socket.send(
      JSON.stringify({ type: "auth", roomId, userId, token: userToken })
    );
  });

  socket.on("message", (raw) => {
    let msg: { type?: string; sessionId?: string; content?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.content === "string") {
      remoteInput?.(msg.content);
      return;
    }
    if (msg.type === "auth_ok" && typeof msg.sessionId === "string") {
      sessionId = msg.sessionId;
      wireState = "ready";
      backoffMs = 1_000;
      if (everHadSession) {
        process.stderr.write(
          `\n[tandem] reconnected to tandem-server. The server does not ` +
            `resume sessions — output now streams to new session ` +
            `${sessionId}.\n`
        );
      }
      everHadSession = true;
      for (const event of pendingEvents.splice(0)) {
        sendEvent(event.content, event.raw, event.timestamp);
      }
    }
  });

  // Connection failures can surface as AggregateError with an empty message;
  // fall back to the error code so the warning stays informative.
  socket.on("error", (err) =>
    handleDrop(
      socket,
      err.message || (err as NodeJS.ErrnoException).code || err.name
    )
  );
  socket.on("close", (code, reason) => {
    if (!shuttingDown && FATAL_CLOSE_CODES.has(code)) {
      goDead(
        `tandem-server rejected the connection (${code}: ${reason}). ` +
          `Not retrying — check TANDEM_USER_TOKEN (it may have expired).`
      );
      return;
    }
    handleDrop(socket, `closed: ${code}${reason.length ? ` ${reason}` : ""}`);
  });
}

/** Handles an unexpected drop of `socket` (null = constructor failure). */
function handleDrop(socket: WebSocket | null, reason: string) {
  // "error" is typically followed by "close" on the same socket; the first
  // call clears `ws`, so the second is recognized as stale and ignored.
  if (socket !== null && ws !== socket) return;
  if (shuttingDown || wireState === "dead") return;

  ws = null;
  sessionId = null;
  if (wireState !== "reconnecting") {
    process.stderr.write(
      `\n[tandem] warning: lost connection to tandem-server (${reason}). ` +
        `Claude Code is unaffected; reconnecting in the background...\n`
    );
  }
  wireState = "reconnecting";

  if (reconnectTimer) return;
  reconnectTimer = setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

if (!isStatusMode) connect();

function sendEvent(content: string, raw: string, timestamp: string) {
  if (wireState === "dead") return;
  if (wireState !== "ready" || !ws || !sessionId) {
    if (pendingEvents.length >= MAX_PENDING_EVENTS) pendingEvents.shift();
    pendingEvents.push({ content, raw, timestamp });
    return;
  }
  ws.send(
    JSON.stringify({
      type: "event",
      sessionId,
      eventType: "output",
      // Stripped content is the durable record; raw (ANSI intact) feeds the
      // live terminal rendering in the web app.
      content,
      raw,
      timestamp,
    })
  );
}

// ─── Room memory injection (Stage 6) ─────────────────────────────────────────
// One-time fetch at startup: pull the room's pinned memory from tandem-server
// and write it into a local context file so Claude Code picks it up
// automatically. Never blocks the session: on any failure we warn and launch
// normally. Never clobbers an existing CLAUDE.md — those are the user's own
// project instructions.

interface MemoryEntry {
  content: string;
  tags?: string[];
}

interface ActivityEntry {
  email: string;
  lastSummary?: string | null;
}

async function fetchAndWriteMemory(): Promise<void> {
  // The WS URL doubles as the HTTP base (ws->http, wss->https).
  const httpUrl = serverUrl!.replace(/^ws/i, "http");
  const headers = { Authorization: `Bearer ${userToken}` };

  let entries: MemoryEntry[] = [];
  let memoryFailed = false;
  try {
    const res = await fetch(`${httpUrl}/rooms/${roomId}/memory`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const json = (await res.json()) as { entries?: MemoryEntry[] };
    entries = Array.isArray(json.entries) ? json.entries : [];
  } catch (err) {
    memoryFailed = true;
    process.stderr.write(
      `[tandem] warning: could not fetch room memory ` +
        `(${err instanceof Error ? err.message : err}).\n`
    );
  }

  // Live teammate context (Stage 11): what active sessions in this room are
  // currently working on, from the server's auto-summaries.
  let activity: ActivityEntry[] = [];
  try {
    const res = await fetch(`${httpUrl}/rooms/${roomId}/activity`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const json = (await res.json()) as { sessions?: ActivityEntry[] };
    activity = Array.isArray(json.sessions) ? json.sessions : [];
  } catch (err) {
    process.stderr.write(
      `[tandem] warning: could not fetch room activity ` +
        `(${err instanceof Error ? err.message : err}).\n`
    );
  }

  if (entries.length === 0 && activity.length === 0) {
    if (memoryFailed) {
      process.stderr.write(`[tandem] launching without room context.\n`);
    }
    return;
  }

  const lines = [
    "# Tandem Room Memory",
    "",
    `Auto-generated from this Tandem room ` +
      `(${new Date().toISOString()}). Treat these as project context and ` +
      `conventions pinned by the team.`,
  ];
  if (entries.length > 0) {
    lines.push(
      "",
      ...entries.map((e) => {
        const tags = e.tags?.length ? ` _(tags: ${e.tags.join(", ")})_` : "";
        // Indent continuation lines so multi-line entries stay one bullet.
        return `- ${String(e.content).replace(/\r?\n/g, "\n  ")}${tags}`;
      })
    );
  }
  if (activity.length > 0) {
    lines.push(
      "",
      "## Currently active in this room",
      "",
      "Live AI coding sessions running right now (auto-summarized; may " +
        "include this session):",
      "",
      ...activity.map(
        (a) => `- ${a.email}: ${a.lastSummary ?? "(session just started)"}`
      )
    );
  }
  lines.push("");
  const body = lines.join("\n");

  const claudeMdExists = fs.existsSync(path.join(process.cwd(), "CLAUDE.md"));
  const target = claudeMdExists ? "TANDEM_MEMORY.md" : "CLAUDE.md";
  try {
    fs.writeFileSync(path.join(process.cwd(), target), body);
  } catch (err) {
    process.stderr.write(
      `[tandem] warning: could not write ${target} ` +
        `(${err instanceof Error ? err.message : err}). Launching without it.\n`
    );
    return;
  }
  const summaryOfContents =
    `${entries.length} pinned entries, ${activity.length} active sessions`;
  if (claudeMdExists) {
    process.stderr.write(
      `[tandem] a CLAUDE.md already exists here, so room memory was written ` +
        `to TANDEM_MEMORY.md instead (${summaryOfContents}). Reference ` +
        `it manually — Tandem never overwrites your project instructions.\n`
    );
  } else {
    process.stderr.write(
      `[tandem] wrote room context to CLAUDE.md (${summaryOfContents})\n`
    );
  }
}

// ─── Status bar (Stage 13) ───────────────────────────────────────────────────
// A fixed region at the TOP of the terminal showing live teammate activity
// while Claude Code runs beneath it. Mechanics:
//   - DECSTBM (\x1b[<top>;<bottom>r) confines scrolling to the area BELOW
//     the reserved rows, so Claude Code's output never scrolls the bar away.
//   - The wrapped process is told the terminal has (rows - STATUS_ROWS) rows,
//     at spawn AND on every resize, so it lays out within its real space.
//   - Redraws use save/restore cursor (DECSC \x1b7 / DECRC \x1b8 — the DEC
//     forms, honored more consistently than CSI s/u, incl. Windows Terminal)
//     around absolute-positioned writes into the reserved rows, so the
//     user's real cursor position below is never disturbed.
//   - The region height is FIXED at 4 rows: dynamically growing/shrinking it
//     would force a PTY re-resize (and a Claude Code re-render) every time
//     the session count changed. ≤4 sessions render directly; more shows
//     3 + "+N more". Disabled entirely on non-TTY stdout, terminals under
//     12 rows, or TANDEM_NO_STATUS_BAR=1.
//   - Cleanup (normal exit, signals, crashes) resets the scroll region and
//     clears the reserved rows — a corrupted terminal after exit would be a
//     serious regression, so restoreTerminal() is idempotent and registered
//     on every exit path.

const STATUS_REFRESH_MS = 15_000;
/** Below this many terminal rows the reserved bar would eat too much space. */
const STATUS_MIN_TERMINAL_ROWS = 15;

// Eligibility (session mode only): a real TTY, tall enough to spare the rows,
// and not explicitly opted out. Any of these failing means the bar stays off
// and the CLI behaves exactly as it did before Stage 13.
const statusBarEnabled =
  !isStatusMode &&
  !!process.stdout.isTTY &&
  (process.stdout.rows ?? 0) >= STATUS_MIN_TERMINAL_ROWS &&
  !process.env.TANDEM_NO_STATUS_BAR;

// Env-gated diagnostic channel (TANDEM_STATUS_DEBUG). Useful when a user's
// terminal misbehaves — and the only way to observe the status bar's
// lifecycle under Windows ConPTY, which consumes DECSTBM/cursor escapes
// rather than echoing them, so the raw bytes never reach a PTY reader.
function statusDebug(msg: string): void {
  if (process.env.TANDEM_STATUS_DEBUG) {
    process.stderr.write(`[tandem-debug] ${msg}\n`);
  }
}
statusDebug(
  `enabled=${statusBarEnabled} isTTY=${process.stdout.isTTY} rows=${process.stdout.rows}`
);

let statusInterval: NodeJS.Timeout | null = null;
let terminalRestored = false;
let statusOffline = false;
let statusActivity: { email: string; lastSummary?: string | null; connected?: boolean }[] | null =
  null; // null = still loading

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

function termRows(): number {
  return process.stdout.rows ?? 24;
}
function termCols(): number {
  return process.stdout.columns ?? 80;
}
/** Rows available to the wrapped process. */
function usableRows(): number {
  return statusBarEnabled ? Math.max(4, termRows() - STATUS_ROWS) : termRows();
}

/** (Re)applies the scroll region against the current terminal height. */
function setScrollRegion(): void {
  const seq = scrollRegionSeq(termRows());
  statusDebug(`region set rows=${termRows()} seq=${JSON.stringify(seq)}`);
  process.stdout.write(seq);
}

/** Truncate a display line to the terminal width (bar lines are plain text
    plus our own color prefixes, so slicing visible text by chars is fine). */
function fitLine(prefix: string, text: string): string {
  const max = Math.max(10, termCols() - 1);
  const visible = text.length > max ? text.slice(0, max - 1) + "…" : text;
  return prefix + visible + RESET;
}

function drawStatusBar(): void {
  if (!statusBarEnabled || terminalRestored) return;
  const lines: string[] = [];
  if (statusOffline) {
    lines.push(fitLine(YELLOW + DIM, "⚠ tandem — offline (teammate activity unavailable)"));
  } else if (statusActivity === null) {
    lines.push(fitLine(DIM, "· tandem — loading teammate activity…"));
  } else {
    const others = statusActivity;
    if (others.length === 0) {
      lines.push(fitLine(DIM, "· tandem — no other active sessions in this room"));
    } else {
      const shown = others.length > STATUS_ROWS ? others.slice(0, STATUS_ROWS - 1) : others;
      for (const s of shown) {
        const dot = s.connected === false ? DIM + "○" + RESET : GREEN + "●" + RESET;
        lines.push(
          dot + fitLine(DIM, ` ${s.email} — ${s.lastSummary ?? "just started…"}`)
        );
      }
      if (others.length > STATUS_ROWS) {
        lines.push(
          fitLine(DIM, `  +${others.length - shown.length} more — run 'tandem status'`)
        );
      }
    }
  }
  statusDebug(`bar draw rows=${termRows()}`);
  process.stdout.write(barUpdateSeq(termRows(), lines));
}

// Redraw throttle. The wrapped app's own rendering can transiently overwrite
// the reserved rows (a mis-restored cursor, a margins reset, a full repaint).
// Rather than waiting up to the 15s fetch interval to repaint — which is what
// made the bar "disappear for a few seconds" — we redraw shortly after the
// app produces output, so the bar heals within DRAW_THROTTLE_MS. The throttle
// (leading + trailing) coalesces output bursts so a streaming response
// redraws at a bounded rate instead of on every chunk.
const DRAW_THROTTLE_MS = 200;
let lastDrawAt = 0;
let pendingDrawTimer: NodeJS.Timeout | null = null;

function scheduleDraw(): void {
  if (!statusBarEnabled || terminalRestored) return;
  const sinceLast = Date.now() - lastDrawAt;
  if (sinceLast >= DRAW_THROTTLE_MS) {
    lastDrawAt = Date.now();
    drawStatusBar();
  } else if (!pendingDrawTimer) {
    pendingDrawTimer = setTimeout(() => {
      pendingDrawTimer = null;
      lastDrawAt = Date.now();
      drawStatusBar();
    }, DRAW_THROTTLE_MS - sinceLast);
  }
}

/** Fetches activity and redraws. Failures flip to "offline" — they must
    never crash or block the session below. */
async function refreshStatusBar(): Promise<void> {
  if (!statusBarEnabled || terminalRestored) return;
  try {
    const httpUrl = serverUrl!.replace(/^ws/i, "http");
    const res = await fetch(`${httpUrl}/rooms/${roomId}/activity`, {
      headers: { Authorization: `Bearer ${userToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const json = (await res.json()) as {
      sessions?: { sessionId: string; email: string; lastSummary?: string | null; connected?: boolean }[];
    };
    // Teammate activity: exclude this session's own entry once we know our id.
    statusActivity = (json.sessions ?? []).filter((s) => s.sessionId !== sessionId);
    statusOffline = false;
  } catch {
    statusOffline = true;
  }
  scheduleDraw();
}

/** Idempotent full-terminal restore — called on EVERY exit path (in raw mode
    Ctrl+C is forwarded to the PTY, so the wrapped process usually exits and
    onExit restores; the signal handlers cover the other paths). */
function restoreTerminal(): void {
  if (!statusBarEnabled || terminalRestored) return;
  terminalRestored = true;
  if (statusInterval) clearInterval(statusInterval);
  if (pendingDrawTimer) clearTimeout(pendingDrawTimer);
  statusDebug(`restore rows=${termRows()}`);
  process.stdout.write(restoreSeq(termRows()));
}

registerExitHandlers(restoreTerminal, (err) => {
  process.stderr.write(
    `[tandem] fatal: ${err instanceof Error ? (err.stack ?? err.message) : err}\n`
  );
});

// ─── PTY ─────────────────────────────────────────────────────────────────────

function startPty(): void {
// On Windows the target is often a .cmd shim (e.g. npm-installed `claude`),
// which ConPTY's CreateProcess won't resolve on its own — route through cmd.exe.
const isWindows = process.platform === "win32";
const file = isWindows ? "cmd.exe" : command;
const args = isWindows ? ["/c", command, ...commandArgs] : commandArgs;

// Reserve the top rows BEFORE spawning, so Claude Code's very first output
// already scrolls only within its own region and never touches the bar.
if (statusBarEnabled) {
  setScrollRegion();
}

const ptyProcess = pty.spawn(file, args, {
  name: "xterm-256color",
  cols: termCols(),
  // Report the reduced height so Claude Code lays out within its real space.
  rows: usableRows(),
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
});

// Local session capture, kept alongside the network path.
const capturedChunks: CapturedChunk[] = [];

ptyProcess.onData((data) => {
  process.stdout.write(data);
  // The app just painted; repaint the bar shortly after so it heals if that
  // output touched the reserved rows (throttled — see scheduleDraw).
  scheduleDraw();
  const stripped = stripAnsi(data);
  capturedChunks.push({ raw: data, stripped, timestamp: Date.now() });
  sendEvent(stripped, data, new Date().toISOString());
});

// Remote control (Stage 10): server-forwarded input goes straight to the
// PTY, same as local stdin. Local stdin below is untouched and always works.
remoteInput = (data) => ptyProcess.write(data);

// Forward the user's keystrokes to the PTY. Raw mode so control keys
// (arrows, Ctrl+C, etc.) reach Claude Code instead of being interpreted here.
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("data", (data: Buffer) => {
  ptyProcess.write(data.toString("utf8"));
});

process.stdout.on("resize", () => {
  if (statusBarEnabled) {
    // Re-establish the reserved region against the NEW height, hand the
    // wrapped process its new usable height, then redraw the bar in place.
    setScrollRegion();
    ptyProcess.resize(termCols(), usableRows());
    drawStatusBar();
  } else {
    ptyProcess.resize(termCols(), termRows());
  }
});

// Reserve the region and paint the bar immediately (loading state), then
// refresh on an interval — don't wait a full tick for the first activity.
if (statusBarEnabled) {
  drawStatusBar();
  void refreshStatusBar();
  statusInterval = setInterval(() => {
    void refreshStatusBar();
  }, STATUS_REFRESH_MS);
}

ptyProcess.onExit(({ exitCode }) => {
  remoteInput = null;
  // Restore the terminal promptly on the normal exit path (idempotent — the
  // process 'exit'/signal handlers are the safety net for other paths).
  restoreTerminal();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();

  // Temporary verification scaffolding.
  const totalRawBytes = capturedChunks.reduce(
    (sum, chunk) => sum + Buffer.byteLength(chunk.raw, "utf8"),
    0
  );
  const totalStrippedChars = capturedChunks.reduce(
    (sum, chunk) => sum + chunk.stripped.length,
    0
  );
  process.stderr.write(
    `\n[tandem] capture summary: ${capturedChunks.length} chunks, ` +
      `${totalRawBytes} raw bytes, ${totalStrippedChars} stripped characters\n`
  );

  // Close the WebSocket gracefully so the server marks the session ended,
  // giving buffered sends a moment to flush — but never hold the exit long.
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws && wireState === "ready" && ws.readyState === WebSocket.OPEN) {
    const timeout = setTimeout(() => process.exit(exitCode), 750);
    ws.on("close", () => {
      clearTimeout(timeout);
      process.exit(exitCode);
    });
    ws.close(1000, "session ended");
  } else {
    ws?.terminate();
    process.exit(exitCode);
  }
});
}

// ─── `tandem status` (Stage 13) ──────────────────────────────────────────────
// One-shot: fetch current activity + recent history for the room, print a
// clean listing, exit. No WebSocket, no PTY, no persistent anything.

interface StatusActivityEntry {
  email: string;
  lastSummary?: string | null;
  lastSummaryAt?: string | null;
  connected?: boolean;
}
interface StatusHistoryEntry {
  email: string;
  isBranch: boolean;
  lastSummary: string;
  lastSummaryAt?: string | null;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function runStatusCommand(): Promise<void> {
  const httpUrl = serverUrl!.replace(/^ws/i, "http");
  const headers = { Authorization: `Bearer ${userToken}` };
  try {
    const [activityRes, historyRes] = await Promise.all([
      fetch(`${httpUrl}/rooms/${roomId}/activity`, {
        headers,
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`${httpUrl}/rooms/${roomId}/history`, {
        headers,
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    if (!activityRes.ok) throw new Error(`activity: server returned ${activityRes.status}`);
    if (!historyRes.ok) throw new Error(`history: server returned ${historyRes.status}`);
    const activity = ((await activityRes.json()) as { sessions?: StatusActivityEntry[] })
      .sessions ?? [];
    const history = ((await historyRes.json()) as { sessions?: StatusHistoryEntry[] })
      .sessions ?? [];

    const lines: string[] = [];
    lines.push(`tandem status — room ${roomId}`);
    lines.push("");
    lines.push(`ACTIVE (${activity.length})`);
    if (activity.length === 0) {
      lines.push("  no active sessions");
    } else {
      for (const s of activity) {
        const dot = s.connected === false ? "○" : "●";
        const when = s.lastSummaryAt ? `  (${relativeTime(s.lastSummaryAt)})` : "";
        lines.push(`  ${dot} ${s.email} — ${s.lastSummary ?? "just started…"}${when}`);
      }
    }
    lines.push("");
    lines.push(`HISTORY (last ${history.length})`);
    if (history.length === 0) {
      lines.push("  no summarized history yet");
    } else {
      for (const h of history) {
        const badge = h.isBranch ? " [branch]" : "";
        const when = h.lastSummaryAt ? `  (${relativeTime(h.lastSummaryAt)})` : "";
        lines.push(`  ○ ${h.email}${badge} — ${h.lastSummary}${when}`);
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[tandem] status failed: ${err instanceof Error ? err.message : err}\n`
    );
    process.exit(1);
  }
}

// Fetch memory first (bounded at 5s, never fatal), then launch the session.
if (isStatusMode) {
  void runStatusCommand();
} else {
  void (async () => {
    await fetchAndWriteMemory();
    startPty();
  })();
}
