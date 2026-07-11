#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as pty from "node-pty";
import stripAnsi from "strip-ansi";
import WebSocket from "ws";

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
  process.stderr.write("Example: tandem claude\n");
  process.exit(1);
}

// ─── Tandem server connection config ─────────────────────────────────────────

const serverUrl = process.env.TANDEM_SERVER_URL;
const roomId = process.env.TANDEM_ROOM_ID;
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
const pendingEvents: { content: string; timestamp: string }[] = [];

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
    let msg: { type?: string; sessionId?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
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
        sendEvent(event.content, event.timestamp);
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

connect();

function sendEvent(content: string, timestamp: string) {
  if (wireState === "dead") return;
  if (wireState !== "ready" || !ws || !sessionId) {
    if (pendingEvents.length >= MAX_PENDING_EVENTS) pendingEvents.shift();
    pendingEvents.push({ content, timestamp });
    return;
  }
  ws.send(
    JSON.stringify({
      type: "event",
      sessionId,
      eventType: "output",
      content,
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

async function fetchAndWriteMemory(): Promise<void> {
  // The WS URL doubles as the HTTP base (ws->http, wss->https).
  const httpUrl = serverUrl!.replace(/^ws/i, "http");
  let entries: MemoryEntry[];
  try {
    const res = await fetch(`${httpUrl}/rooms/${roomId}/memory`, {
      headers: { Authorization: `Bearer ${userToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const json = (await res.json()) as { entries?: MemoryEntry[] };
    entries = Array.isArray(json.entries) ? json.entries : [];
  } catch (err) {
    process.stderr.write(
      `[tandem] warning: could not fetch room memory ` +
        `(${err instanceof Error ? err.message : err}). ` +
        `Launching without it.\n`
    );
    return;
  }
  if (entries.length === 0) return;

  const body = [
    "# Tandem Room Memory",
    "",
    `Auto-generated from this Tandem room's pinned memory ` +
      `(${new Date().toISOString()}). Treat these as project context and ` +
      `conventions pinned by the team.`,
    "",
    ...entries.map((e) => {
      const tags = e.tags?.length ? ` _(tags: ${e.tags.join(", ")})_` : "";
      // Indent continuation lines so multi-line entries stay one bullet.
      return `- ${String(e.content).replace(/\r?\n/g, "\n  ")}${tags}`;
    }),
    "",
  ].join("\n");

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
  if (claudeMdExists) {
    process.stderr.write(
      `[tandem] a CLAUDE.md already exists here, so room memory was written ` +
        `to TANDEM_MEMORY.md instead (${entries.length} entries). Reference ` +
        `it manually — Tandem never overwrites your project instructions.\n`
    );
  } else {
    process.stderr.write(
      `[tandem] wrote ${entries.length} pinned memory entries to CLAUDE.md\n`
    );
  }
}

// ─── PTY ─────────────────────────────────────────────────────────────────────

function startPty(): void {
// On Windows the target is often a .cmd shim (e.g. npm-installed `claude`),
// which ConPTY's CreateProcess won't resolve on its own — route through cmd.exe.
const isWindows = process.platform === "win32";
const file = isWindows ? "cmd.exe" : command;
const args = isWindows ? ["/c", command, ...commandArgs] : commandArgs;

const ptyProcess = pty.spawn(file, args, {
  name: "xterm-256color",
  cols: process.stdout.columns ?? 80,
  rows: process.stdout.rows ?? 24,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
});

// Local session capture, kept alongside the network path.
const capturedChunks: CapturedChunk[] = [];

ptyProcess.onData((data) => {
  process.stdout.write(data);
  const stripped = stripAnsi(data);
  capturedChunks.push({ raw: data, stripped, timestamp: Date.now() });
  sendEvent(stripped, new Date().toISOString());
});

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
  ptyProcess.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
});

ptyProcess.onExit(({ exitCode }) => {
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

// Fetch memory first (bounded at 5s, never fatal), then launch the session.
void (async () => {
  await fetchAndWriteMemory();
  startPty();
})();
