#!/usr/bin/env node
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
// must never interrupt the Claude Code session: on any failure we warn once
// on stderr and continue local-only.

type WireState = "connecting" | "ready" | "dead";
let wireState: WireState = "connecting";
let sessionId: string | null = null;
/** Chunks captured before auth_ok arrives, flushed once we have a sessionId. */
const pendingEvents: { content: string; timestamp: string }[] = [];

/** True once we start our own graceful shutdown — suppresses the offline warning. */
let shuttingDown = false;

function warnOffline(reason: string) {
  if (wireState === "dead") return;
  wireState = "dead";
  pendingEvents.length = 0;
  if (shuttingDown) return;
  process.stderr.write(
    `\n[tandem] warning: lost connection to tandem-server (${reason}). ` +
      `Session continues locally; events are no longer being sent.\n`
  );
}

let ws: WebSocket | null = null;
try {
  ws = new WebSocket(serverUrl!);
} catch (err) {
  warnOffline(err instanceof Error ? err.message : String(err));
}

if (ws) {
  ws.on("open", () => {
    ws!.send(JSON.stringify({ type: "auth", roomId, userId, token: userToken }));
  });

  ws.on("message", (raw) => {
    let msg: { type?: string; sessionId?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "auth_ok" && typeof msg.sessionId === "string") {
      sessionId = msg.sessionId;
      wireState = "ready";
      for (const event of pendingEvents.splice(0)) {
        sendEvent(event.content, event.timestamp);
      }
    }
  });

  // Connection failures can surface as AggregateError with an empty message;
  // fall back to the error code so the warning stays informative.
  ws.on("error", (err) =>
    warnOffline(
      err.message || (err as NodeJS.ErrnoException).code || err.name
    )
  );
  ws.on("close", (code, reason) => {
    warnOffline(`closed: ${code}${reason.length ? ` ${reason}` : ""}`);
  });
}

function sendEvent(content: string, timestamp: string) {
  if (wireState === "dead" || !ws) return;
  if (wireState === "connecting" || !sessionId) {
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

// ─── PTY ─────────────────────────────────────────────────────────────────────

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
