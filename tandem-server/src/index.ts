import "dotenv/config";
import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import {
  Liveblocks,
  LiveList,
  LiveMap,
  LiveObject,
} from "@liveblocks/node";
import { WebSocketServer, WebSocket } from "ws";

// ─── Config ──────────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LIVEBLOCKS_SECRET_KEY } =
  process.env;
const PORT = Number(process.env.PORT ?? 8787);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "[tandem-server] Missing required env vars. Set SUPABASE_URL and " +
      "SUPABASE_SERVICE_ROLE_KEY (see .env.example)."
  );
  process.exit(1);
}

// Service role client: bypasses RLS so the server can write on behalf of
// users. This server is the only component allowed to hold this key.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Liveblocks (live/ephemeral layer) ───────────────────────────────────────
// This server is the ONLY writer to Liveblocks. Supabase remains the durable
// source of truth; every Liveblocks write happens alongside (never instead
// of) the Supabase write, and a Liveblocks failure must never block it.

const liveblocks = LIVEBLOCKS_SECRET_KEY
  ? new Liveblocks({ secret: LIVEBLOCKS_SECRET_KEY })
  : null;

if (!liveblocks) {
  console.warn(
    "[tandem-server] LIVEBLOCKS_SECRET_KEY not set — running without the " +
      "live layer. Sessions are still written durably to Supabase."
  );
}

/** One Liveblocks room per Tandem room. */
const liveRoomId = (roomId: string) => `tandem-room-${roomId}`;

/** Rooms already upserted this process, to skip redundant API calls. */
const ensuredLiveRooms = new Set<string>();

async function ensureLiveRoom(roomId: string): Promise<void> {
  if (!liveblocks || ensuredLiveRooms.has(roomId)) return;
  // upsertRoom requires a non-empty update; re-asserting defaultAccesses is
  // idempotent and creates the room if it doesn't exist yet.
  await liveblocks.upsertRoom(liveRoomId(roomId), {
    update: { defaultAccesses: ["room:write"] },
  });
  ensuredLiveRooms.add(roomId);
}

/**
 * Live storage shape per room:
 *   root.sessions: LiveMap<sessionId, LiveObject<{
 *     userId, status, events: LiveList<{ eventType, content, timestamp }>
 *   }>>
 */
type LiveSession = LiveObject<{
  userId: string;
  status: string;
  /** Set when this session was branched from another (Stage 5). */
  parentSessionId?: string | null;
  /** Remote-control mirror (Stage 10). Authoritative state lives in server
      memory; these fields exist only so browsers can render control UI. */
  controllerId?: string | null;
  pendingRequesterId?: string | null;
  pendingRequestedAt?: string | null;
  /** Auto-summarized "what is this session working on" (Stage 11). */
  lastSummary?: string | null;
  lastSummaryAt?: string | null;
  events: LiveList<{
    eventType: string;
    content: string;
    raw?: string;
    timestamp: string;
  }>;
}>;

async function liveSessionStart(state: ConnectionState): Promise<void> {
  if (!liveblocks) return;
  try {
    await ensureLiveRoom(state.roomId);
    await liveblocks.mutateStorage(liveRoomId(state.roomId), ({ root }) => {
      let sessions = root.get("sessions") as LiveMap<string, LiveSession>;
      if (!sessions) {
        sessions = new LiveMap();
        root.set("sessions", sessions);
      }
      sessions.set(
        state.sessionId,
        new LiveObject({
          userId: state.userId,
          status: "active",
          parentSessionId: null,
          events: new LiveList([]),
        })
      );
    });
  } catch (err) {
    console.error(
      `[tandem-server] liveblocks: failed to start session ` +
        `${state.sessionId}: ${err instanceof Error ? err.message : err}`
    );
  }
}

async function liveSessionEvent(
  state: ConnectionState,
  event: { eventType: string; content: string; raw?: string; timestamp: string }
): Promise<void> {
  if (!liveblocks) return;
  try {
    await liveblocks.mutateStorage(liveRoomId(state.roomId), ({ root }) => {
      const sessions = root.get("sessions") as LiveMap<string, LiveSession>;
      sessions?.get(state.sessionId)?.get("events").push(event);
    });
  } catch (err) {
    console.error(
      `[tandem-server] liveblocks: failed to push event for session ` +
        `${state.sessionId}: ${err instanceof Error ? err.message : err}`
    );
  }
}

async function liveSessionEnd(state: ConnectionState): Promise<void> {
  if (!liveblocks) return;
  try {
    await liveblocks.mutateStorage(liveRoomId(state.roomId), ({ root }) => {
      const sessions = root.get("sessions") as LiveMap<string, LiveSession>;
      sessions?.get(state.sessionId)?.set("status", "ended");
    });
  } catch (err) {
    console.error(
      `[tandem-server] liveblocks: failed to end session ` +
        `${state.sessionId}: ${err instanceof Error ? err.message : err}`
    );
  }
}

// ─── Protocol types ──────────────────────────────────────────────────────────

interface AuthMessage {
  type: "auth";
  /** "web" = browser connection (control input); absent/other = CLI. */
  role?: string;
  roomId: string;
  userId: string;
  token: string;
}

interface EventMessage {
  type: "event";
  sessionId: string;
  eventType: string;
  /** ANSI-stripped content — the durable form stored in Supabase. */
  content: string;
  /** Raw PTY output with ANSI codes intact, for terminal rendering (live layer only). */
  raw?: string;
  timestamp: string;
}

/** Browser -> server: keystrokes for a remotely-controlled session. */
interface SessionInputMessage {
  type: "session_input";
  sessionId: string;
  content: string;
}

type ClientMessage = AuthMessage | EventMessage | SessionInputMessage;

interface ConnectionState {
  userId: string;
  roomId: string;
  sessionId: string;
}

// Close codes in the 4000-4999 application range.
const CLOSE_AUTH_FAILED = 4001;
const CLOSE_PROTOCOL_ERROR = 4002;
const CLOSE_SERVER_ERROR = 4011;

// ─── Connection handling ─────────────────────────────────────────────────────

async function handleAuth(
  ws: WebSocket,
  msg: AuthMessage
): Promise<ConnectionState | null> {
  const { data, error } = await supabase.auth.getUser(msg.token);
  if (error || !data.user) {
    ws.close(CLOSE_AUTH_FAILED, "invalid token");
    return null;
  }
  if (data.user.id !== msg.userId) {
    ws.close(CLOSE_AUTH_FAILED, "token does not match userId");
    return null;
  }
  // Stage 12 audit fix: sessions may only be opened INTO rooms the user is a
  // member of. Without this, any authenticated user who knew a room's UUID
  // could plant a session (and stream content) into it.
  if (!(await isRoomMember(msg.roomId, msg.userId))) {
    ws.close(CLOSE_AUTH_FAILED, "not a member of this room");
    return null;
  }

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .insert({ room_id: msg.roomId, user_id: msg.userId, status: "active" })
    .select("id")
    .single();
  if (sessionError || !session) {
    console.error(
      `[tandem-server] failed to create session: ${sessionError?.message}`
    );
    ws.close(CLOSE_SERVER_ERROR, "failed to create session");
    return null;
  }

  // Register the live connection BEFORE auth_ok goes out: control requests
  // can arrive the moment the client learns its sessionId, and they check
  // this map.
  cliSocketBySession.set(session.id, ws);

  const state: ConnectionState = {
    userId: msg.userId,
    roomId: msg.roomId,
    sessionId: session.id,
  };

  // Seed the Liveblocks entry BEFORE auth_ok too: control-state mirroring
  // assumes the session entry exists once anyone knows the sessionId.
  // (liveSessionStart never throws — Liveblocks failures are logged inside.)
  await liveSessionStart(state);

  // The socket may have closed while the writes above were in flight; the
  // session row still exists and the close handler will mark it ended.
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "auth_ok", sessionId: session.id }));
  }
  console.log(
    `[tandem-server] session ${session.id} started ` +
      `(user ${msg.userId}, room ${msg.roomId})`
  );
  return state;
}

async function handleEvent(state: ConnectionState, msg: EventMessage) {
  if (msg.sessionId !== state.sessionId) {
    console.warn(
      `[tandem-server] dropping event with mismatched sessionId ` +
        `${msg.sessionId} (expected ${state.sessionId})`
    );
    return;
  }
  const { error } = await supabase.from("session_events").insert({
    session_id: state.sessionId,
    type: msg.eventType,
    content: msg.content,
    created_at: msg.timestamp,
  });
  if (error) {
    console.error(
      `[tandem-server] failed to insert event for session ` +
        `${state.sessionId}: ${error.message}`
    );
  }
  await liveSessionEvent(state, {
    eventType: msg.eventType,
    content: msg.content,
    // Raw ANSI goes to the live layer only (xterm rendering); Supabase keeps
    // the stripped form as the durable, searchable record.
    ...(typeof msg.raw === "string" ? { raw: msg.raw } : {}),
    timestamp: msg.timestamp,
  });
  // Feed the summarizer (Stage 11) — marks the session dirty for the next tick.
  summaryTrackEvent(state, msg.content);
}

async function endSession(state: ConnectionState) {
  const { error } = await supabase
    .from("sessions")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("id", state.sessionId);
  if (error) {
    console.error(
      `[tandem-server] failed to end session ${state.sessionId}: ${error.message}`
    );
  } else {
    console.log(`[tandem-server] session ${state.sessionId} ended`);
  }
  await liveSessionEnd(state);
}

// ─── Orphan sweep ────────────────────────────────────────────────────────────
// If the server crashes, sessions it was holding are never marked ended. This
// is a single-server architecture: at boot no connections exist yet, so any
// session still "active" is by definition orphaned — end it. (Liveblocks
// entries for orphans are corrected lazily: statuses there matter less than
// the durable record, and rewriting every room's storage at boot is wasteful.)
{
  // Branched sessions (parent_session_id set) are static copies with no
  // connection backing them — "active" is their normal state, so they are
  // not orphans. Revisit if/when live continuation of branches lands.
  const { data: orphans, error } = await supabase
    .from("sessions")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("status", "active")
    .is("parent_session_id", null)
    .select("id, room_id");
  if (error) {
    console.error(`[tandem-server] orphan sweep failed: ${error.message}`);
  } else if (orphans && orphans.length > 0) {
    console.log(
      `[tandem-server] orphan sweep: ended ${orphans.length} session(s) ` +
        `left active by a previous run`
    );
    if (liveblocks) {
      for (const orphan of orphans) {
        try {
          await liveblocks.mutateStorage(
            liveRoomId(orphan.room_id),
            ({ root }) => {
              const sessions = root.get("sessions") as LiveMap<
                string,
                LiveSession
              >;
              sessions?.get(orphan.id)?.set("status", "ended");
            }
          );
        } catch {
          // Room may not exist in Liveblocks; the durable record is what counts.
        }
      }
    }
  }
}

// ─── Remote control state (Stage 10) ─────────────────────────────────────────
// SECURITY-CRITICAL. This server is the SOLE authority on who controls a
// session. State is ephemeral by design (server memory, never Supabase); the
// Liveblocks mirror is display-only and never consulted for authorization.
// Every session_input message is re-verified against controlBySession — a
// client-side claim of "I have control" is never trusted.

interface ControlState {
  controllerId: string;
  roomId: string;
  grantedAt: number;
}
interface PendingControlRequest {
  requesterId: string;
  roomId: string;
  requestedAt: number;
  timer: NodeJS.Timeout;
}

const controlBySession = new Map<string, ControlState>();
const pendingBySession = new Map<string, PendingControlRequest>();
/** Live CLI connection per active session — the only route for input. */
const cliSocketBySession = new Map<string, WebSocket>();
/** Open browser connections per user, for disconnect-triggered release. */
const webSocketsByUser = new Map<string, Set<WebSocket>>();

const CONTROL_REQUEST_TIMEOUT_MS = Number(
  process.env.CONTROL_REQUEST_TIMEOUT_MS ?? 30_000
);

/** Display-only mirror of control state into the room's Liveblocks storage. */
async function mirrorControl(
  roomId: string,
  sessionId: string,
  fields: {
    controllerId: string | null;
    pendingRequesterId: string | null;
    pendingRequestedAt: string | null;
  }
): Promise<void> {
  if (!liveblocks) return;
  try {
    await liveblocks.mutateStorage(liveRoomId(roomId), ({ root }) => {
      const sessions = root.get("sessions") as LiveMap<string, LiveSession>;
      const session = sessions?.get(sessionId);
      if (!session) return;
      session.set("controllerId", fields.controllerId);
      session.set("pendingRequesterId", fields.pendingRequesterId);
      session.set("pendingRequestedAt", fields.pendingRequestedAt);
    });
  } catch (err) {
    console.error(
      `[tandem-server] liveblocks: failed to mirror control state for ` +
        `${sessionId}: ${err instanceof Error ? err.message : err}`
    );
  }
}

function clearPendingRequest(sessionId: string): PendingControlRequest | undefined {
  const pending = pendingBySession.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingBySession.delete(sessionId);
  }
  return pending;
}

/** Clears controller + any pending request; mirrors the reset. */
async function releaseControl(sessionId: string, reason: string): Promise<void> {
  const control = controlBySession.get(sessionId);
  const pending = clearPendingRequest(sessionId);
  if (!control && !pending) return;
  controlBySession.delete(sessionId);
  const roomId = (control ?? pending)!.roomId;
  console.log(
    `[tandem-server] control cleared for session ${sessionId} (${reason})`
  );
  await mirrorControl(roomId, sessionId, {
    controllerId: null,
    pendingRequesterId: null,
    pendingRequestedAt: null,
  });
}

// ─── Session summarization (Stage 11) ────────────────────────────────────────
// Every SUMMARY_INTERVAL_MS, each ACTIVE session that received new events
// since its last summary gets summarized by Claude Haiku into one short
// status line — stored durably on sessions.last_summary and mirrored to
// Liveblocks for the live UI. Idle sessions are skipped (no API call).
//
// ⚠️ Timer lifecycle discipline (cost-critical): there are no per-session
// timers to leak — ONE global interval iterates summaryStateBySession, and a
// session's entry is deleted the moment its CLI connection closes (same
// hook that releases control and marks the session ended). No entry, no API
// call — verified by test/e2e-stage11-summary.mjs.

const SUMMARY_INTERVAL_MS = Number(process.env.SUMMARY_INTERVAL_MS ?? 45_000);
/** Keep roughly the last ~3000 tokens of transcript for the prompt. */
const SUMMARY_BUFFER_MAX_CHARS = 12_000;
const SUMMARY_MODEL = "claude-haiku-4-5";

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
if (!anthropic) {
  console.warn(
    "[tandem-server] ANTHROPIC_API_KEY not set — session summarization is " +
      "disabled. Everything else works normally."
  );
}

interface SummaryState {
  roomId: string;
  /** Rolling tail of recent stripped output. */
  buffer: string;
  /** True when events arrived since the last summary — the API-call gate. */
  dirty: boolean;
}

const summaryStateBySession = new Map<string, SummaryState>();

/** In-memory API call counter, exposed via GET /debug/summaries and logged
    per call, to make call volume easy to sanity-check. */
let summaryCallCount = 0;

function summaryTrackEvent(state: ConnectionState, content: string): void {
  if (!anthropic) return;
  let s = summaryStateBySession.get(state.sessionId);
  if (!s) {
    s = { roomId: state.roomId, buffer: "", dirty: false };
    summaryStateBySession.set(state.sessionId, s);
  }
  s.buffer = (s.buffer + content).slice(-SUMMARY_BUFFER_MAX_CHARS);
  s.dirty = true;
}

/** Called the instant a session's CLI connection closes — stops all future
    summarization for it. */
function summaryStopSession(sessionId: string): void {
  summaryStateBySession.delete(sessionId);
}

/** The single Haiku summarization call — shared by the Stage 11 interval
    summarizer and the Stage 12 one-time branch summary. Returns null when
    the model produced nothing usable. */
async function generateSummary(transcript: string): Promise<string | null> {
  const response = await anthropic!.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 60,
    system:
      "You summarize live AI coding session transcripts. Respond with exactly " +
      "one sentence, under 20 words, concretely describing what this session " +
      "is currently working on, based on the prompts and output shown. Be " +
      "specific (name the feature, file, or action — e.g. 'Refactoring " +
      "checkout validation into a shared hook'), never generic ('Making code " +
      "changes'). No preamble, no quotes.",
    messages: [
      {
        role: "user",
        content:
          "Recent terminal output from the coding session (ANSI stripped):\n\n" +
          transcript.slice(-SUMMARY_BUFFER_MAX_CHARS),
      },
    ],
  });
  summaryCallCount++;
  const summary = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
  return summary || null;
}

async function summarizeSession(sessionId: string, s: SummaryState): Promise<void> {
  const summary = await generateSummary(s.buffer);
  if (!summary) return;

  console.log(
    `[tandem-server] summary #${summaryCallCount} for session ${sessionId}: ` +
      `"${summary}"`
  );

  const at = new Date().toISOString();
  const { error } = await supabase
    .from("sessions")
    .update({ last_summary: summary, last_summary_at: at })
    .eq("id", sessionId);
  if (error) {
    console.error(
      `[tandem-server] failed to store summary for ${sessionId}: ${error.message}`
    );
  }

  if (liveblocks) {
    try {
      await liveblocks.mutateStorage(liveRoomId(s.roomId), ({ root }) => {
        const sessions = root.get("sessions") as LiveMap<string, LiveSession>;
        const session = sessions?.get(sessionId);
        if (!session) return;
        session.set("lastSummary", summary);
        session.set("lastSummaryAt", at);
      });
    } catch (err) {
      console.error(
        `[tandem-server] liveblocks: failed to mirror summary for ` +
          `${sessionId}: ${err instanceof Error ? err.message : err}`
      );
    }
  }
}

if (anthropic) {
  setInterval(() => {
    void (async () => {
      for (const [sessionId, s] of summaryStateBySession) {
        // Session gone but state lingering (shouldn't happen — close handler
        // deletes it): clean up defensively rather than paying for it.
        if (!cliSocketBySession.has(sessionId)) {
          summaryStateBySession.delete(sessionId);
          continue;
        }
        if (!s.dirty) continue; // idle since last summary — no API call
        s.dirty = false; // events arriving during the call re-mark it
        try {
          await summarizeSession(sessionId, s);
        } catch (err) {
          // Leave dirty=false: a persistent API failure must not hammer the
          // API every tick; the next real event re-arms summarization.
          console.error(
            `[tandem-server] summarization failed for ${sessionId}: ` +
              `${err instanceof Error ? err.message : err}`
          );
        }
      }
    })();
  }, SUMMARY_INTERVAL_MS);
}

// ─── Branch endpoint (Stage 5) ───────────────────────────────────────────────
// Branching is initiated from tandem-web, but this server remains the ONLY
// writer to Supabase sessions/events and to Liveblocks — the web app's server
// action calls POST /branch here with the user's Supabase JWT.
//
// A branch is a read-and-copy operation: a new session owned by the CLICKING
// user (anyone in the room may branch anyone's session), seeded with the
// source's first `eventCount` events. The source is never modified. The copy
// reads from Supabase ordered by created_at with LIMIT eventCount: Supabase
// is written before Liveblocks on the live path, so every event a panel can
// display is already durable, and anything arriving after the click falls
// beyond the LIMIT.
//
// Follow-up idea (NOT this stage): let a new `tandem claude` run attach to a
// branched session and continue it live.

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown
) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody(
  req: import("node:http").IncomingMessage
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Verifies the request's bearer token; returns the userId or null. */
async function authUser(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<string | null> {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token) {
    sendJson(res, 401, { error: "missing bearer token" });
    return null;
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    sendJson(res, 401, { error: "invalid token" });
    return null;
  }
  return data.user.id;
}

async function isRoomMember(roomId: string, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("room_members")
    .select("user_id")
    .eq("room_id", roomId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

async function handleBranch(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
) {
  const userId = await authUser(req, res);
  if (!userId) return;

  let body: { sourceSessionId?: unknown; eventCount?: unknown };
  try {
    body = (await readJsonBody(req)) as typeof body;
  } catch (err) {
    return sendJson(res, 400, {
      error: err instanceof Error ? err.message : "bad request",
    });
  }
  const { sourceSessionId, eventCount } = body;
  if (
    typeof sourceSessionId !== "string" ||
    !Number.isInteger(eventCount) ||
    (eventCount as number) < 1
  ) {
    return sendJson(res, 400, {
      error: "sourceSessionId (string) and eventCount (integer >= 1) required",
    });
  }

  const { data: source } = await supabase
    .from("sessions")
    .select("id, room_id")
    .eq("id", sourceSessionId)
    .maybeSingle();
  if (!source) return sendJson(res, 404, { error: "source session not found" });

  if (!(await isRoomMember(source.room_id, userId))) {
    return sendJson(res, 403, { error: "not a member of this room" });
  }

  const { data: events, error: evErr } = await supabase
    .from("session_events")
    .select("type, content, created_at")
    .eq("session_id", sourceSessionId)
    .order("created_at", { ascending: true })
    .limit(eventCount as number);
  if (evErr) return sendJson(res, 500, { error: evErr.message });

  const { data: branch, error: insErr } = await supabase
    .from("sessions")
    .insert({
      room_id: source.room_id,
      user_id: userId,
      parent_session_id: source.id,
      status: "active",
    })
    .select("id")
    .single();
  if (insErr || !branch) {
    return sendJson(res, 500, {
      error: `failed to create branch session: ${insErr?.message}`,
    });
  }

  if (events && events.length > 0) {
    const { error: copyErr } = await supabase.from("session_events").insert(
      events.map((e) => ({
        session_id: branch.id,
        type: e.type,
        content: e.content,
        created_at: e.created_at,
      }))
    );
    if (copyErr) {
      return sendJson(res, 500, {
        error: `failed to copy events: ${copyErr.message}`,
      });
    }
  }

  // Mirror into Liveblocks so the branch appears as a panel immediately.
  // Same alongside-not-instead rule as the live path: a Liveblocks failure
  // is logged but the durable branch already exists.
  if (liveblocks) {
    try {
      await ensureLiveRoom(source.room_id);
      await liveblocks.mutateStorage(liveRoomId(source.room_id), ({ root }) => {
        let sessions = root.get("sessions") as LiveMap<string, LiveSession>;
        if (!sessions) {
          sessions = new LiveMap();
          root.set("sessions", sessions);
        }
        sessions.set(
          branch.id,
          new LiveObject({
            userId,
            status: "active",
            parentSessionId: source.id,
            events: new LiveList(
              (events ?? []).map((e) => ({
                eventType: e.type,
                content: e.content ?? "",
                timestamp: e.created_at,
              }))
            ),
          })
        );
      });
    } catch (err) {
      console.error(
        `[tandem-server] liveblocks: failed to mirror branch ${branch.id}: ` +
          `${err instanceof Error ? err.message : err}`
      );
    }
  }

  console.log(
    `[tandem-server] session ${branch.id} branched from ${source.id} ` +
      `at event ${events?.length ?? 0} (by user ${userId})`
  );
  sendJson(res, 200, { sessionId: branch.id });

  // Stage 12: one-time summary for the static branch copy (async backfill —
  // the response above is already sent). Branches never enter the Stage 11
  // interval summarizer (no CLI connection), so this is their only summary.
  // Skipped when there is nothing to summarize: no content, no API call.
  const transcript = (events ?? []).map((e) => e.content ?? "").join("");
  if (anthropic && transcript.trim().length > 0) {
    void (async () => {
      try {
        const summary = await generateSummary(transcript);
        if (!summary) return;
        console.log(
          `[tandem-server] summary #${summaryCallCount} for branch ` +
            `${branch.id}: "${summary}"`
        );
        const at = new Date().toISOString();
        await supabase
          .from("sessions")
          .update({ last_summary: summary, last_summary_at: at })
          .eq("id", branch.id);
        if (liveblocks) {
          await liveblocks.mutateStorage(liveRoomId(source.room_id), ({ root }) => {
            const sessions = root.get("sessions") as LiveMap<string, LiveSession>;
            const entry = sessions?.get(branch.id);
            if (!entry) return;
            entry.set("lastSummary", summary);
            entry.set("lastSummaryAt", at);
          });
        }
      } catch (err) {
        console.error(
          `[tandem-server] branch summary failed for ${branch.id}: ` +
            `${err instanceof Error ? err.message : err}`
        );
      }
    })();
  }
}

// ─── Memory endpoints (Stage 6) ──────────────────────────────────────────────
// Pinned, durable, room-scoped notes. Manually curated (no AI extraction).
// Same auth pattern as /branch: JWT-verified + membership-checked. RLS on
// memory_entries mirrors these rules as defense in depth.

async function handleMemoryList(
  res: import("node:http").ServerResponse,
  roomId: string,
  userId: string
) {
  if (!(await isRoomMember(roomId, userId))) {
    return sendJson(res, 403, { error: "not a member of this room" });
  }
  const { data, error } = await supabase
    .from("memory_entries")
    .select("id, content, tags, pinned_by, created_at")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false });
  if (error) return sendJson(res, 500, { error: error.message });
  sendJson(res, 200, { entries: data });
}

async function handleMemoryCreate(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  roomId: string,
  userId: string
) {
  if (!(await isRoomMember(roomId, userId))) {
    return sendJson(res, 403, { error: "not a member of this room" });
  }
  let body: { content?: unknown; tags?: unknown };
  try {
    body = (await readJsonBody(req)) as typeof body;
  } catch (err) {
    return sendJson(res, 400, {
      error: err instanceof Error ? err.message : "bad request",
    });
  }
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];
  if (!content) {
    return sendJson(res, 400, { error: "content (non-empty string) required" });
  }
  const { data, error } = await supabase
    .from("memory_entries")
    .insert({ room_id: roomId, content, tags, pinned_by: userId })
    .select("id, content, tags, pinned_by, created_at")
    .single();
  if (error) return sendJson(res, 500, { error: error.message });
  console.log(`[tandem-server] memory ${data.id} pinned in room ${roomId}`);
  sendJson(res, 200, { entry: data });
}

async function handleMemoryDelete(
  res: import("node:http").ServerResponse,
  roomId: string,
  entryId: string,
  userId: string
) {
  if (!(await isRoomMember(roomId, userId))) {
    return sendJson(res, 403, { error: "not a member of this room" });
  }
  const { data: entry } = await supabase
    .from("memory_entries")
    .select("id, pinned_by")
    .eq("id", entryId)
    .eq("room_id", roomId)
    .maybeSingle();
  if (!entry) return sendJson(res, 404, { error: "memory entry not found" });
  if (entry.pinned_by !== userId) {
    return sendJson(res, 403, {
      error: "only the user who pinned an entry can delete it",
    });
  }
  const { error } = await supabase.from("memory_entries").delete().eq("id", entryId);
  if (error) return sendJson(res, 500, { error: error.message });
  console.log(`[tandem-server] memory ${entryId} deleted from room ${roomId}`);
  sendJson(res, 200, { deleted: true });
}

// ─── Chat endpoint (Stage 9) ─────────────────────────────────────────────────
// Human-to-human room chat, separate from AI session content. Same pattern
// as memory: durable insert into Supabase first, then mirrored into the
// room's Liveblocks storage (a chatMessages LiveList alongside the sessions
// LiveMap) so it appears live for everyone viewing the room. History on page
// load comes from Supabase; no edit/delete — messages are permanent.

type LiveChatMessage = {
  id: string;
  userId: string;
  content: string;
  timestamp: string;
};

async function handleChatCreate(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  roomId: string,
  userId: string
) {
  if (!(await isRoomMember(roomId, userId))) {
    return sendJson(res, 403, { error: "not a member of this room" });
  }
  let body: { content?: unknown };
  try {
    body = (await readJsonBody(req)) as typeof body;
  } catch (err) {
    return sendJson(res, 400, {
      error: err instanceof Error ? err.message : "bad request",
    });
  }
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return sendJson(res, 400, { error: "content (non-empty string) required" });
  }
  if (content.length > 4000) {
    return sendJson(res, 400, { error: "content too long (max 4000 chars)" });
  }

  const { data: message, error } = await supabase
    .from("chat_messages")
    .insert({ room_id: roomId, user_id: userId, content })
    .select("id, user_id, content, created_at")
    .single();
  if (error || !message) {
    return sendJson(res, 500, { error: error?.message ?? "insert failed" });
  }

  // Mirror into Liveblocks — alongside, never instead of, the durable write.
  if (liveblocks) {
    try {
      await ensureLiveRoom(roomId);
      await liveblocks.mutateStorage(liveRoomId(roomId), ({ root }) => {
        let chat = root.get("chatMessages") as LiveList<LiveChatMessage>;
        if (!chat) {
          chat = new LiveList([]);
          root.set("chatMessages", chat);
        }
        chat.push({
          id: message.id,
          userId: message.user_id,
          content: message.content,
          timestamp: message.created_at,
        });
      });
    } catch (err) {
      console.error(
        `[tandem-server] liveblocks: failed to mirror chat message ` +
          `${message.id}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  sendJson(res, 200, { message });
}

// ─── Control endpoints (Stage 10) ────────────────────────────────────────────
// request: any room member except the owner, when a session is active,
//   connected, uncontrolled, and has no pending request. Expires after
//   CONTROL_REQUEST_TIMEOUT_MS with no response.
// approve/deny: session owner only (JWT identity must match sessions.user_id).
// release: the current controller (releasing their own control) or the owner
//   (revoking anyone's control at any time).

async function handleControl(
  res: import("node:http").ServerResponse,
  sessionId: string,
  action: string,
  userId: string
) {
  const { data: session } = await supabase
    .from("sessions")
    .select("id, room_id, user_id, status")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return sendJson(res, 404, { error: "session not found" });

  if (!(await isRoomMember(session.room_id, userId))) {
    return sendJson(res, 403, { error: "not a member of this room" });
  }

  const ownerId = session.user_id as string;
  const roomId = session.room_id as string;
  const control = controlBySession.get(sessionId);
  const pending = pendingBySession.get(sessionId);

  switch (action) {
    case "request": {
      if (userId === ownerId) {
        return sendJson(res, 400, {
          error: "you own this session — you always have control via local stdin",
        });
      }
      if (session.status !== "active") {
        return sendJson(res, 409, { error: "session is not active" });
      }
      if (!cliSocketBySession.has(sessionId)) {
        return sendJson(res, 409, { error: "session has no live connection" });
      }
      if (control) {
        return sendJson(res, 409, { error: "session is already being controlled" });
      }
      if (pending) {
        return sendJson(res, 409, { error: "a control request is already pending" });
      }

      const requestedAt = Date.now();
      const timer = setTimeout(() => {
        const current = pendingBySession.get(sessionId);
        if (current && current.requestedAt === requestedAt) {
          pendingBySession.delete(sessionId);
          console.log(
            `[tandem-server] control request for session ${sessionId} ` +
              `timed out (requester ${userId})`
          );
          void mirrorControl(roomId, sessionId, {
            controllerId: null,
            pendingRequesterId: null,
            pendingRequestedAt: null,
          });
        }
      }, CONTROL_REQUEST_TIMEOUT_MS);
      pendingBySession.set(sessionId, {
        requesterId: userId,
        roomId,
        requestedAt,
        timer,
      });
      console.log(
        `[tandem-server] control requested for session ${sessionId} by ${userId}`
      );
      await mirrorControl(roomId, sessionId, {
        controllerId: null,
        pendingRequesterId: userId,
        pendingRequestedAt: new Date(requestedAt).toISOString(),
      });
      return sendJson(res, 200, { pending: true });
    }

    case "approve": {
      if (userId !== ownerId) {
        return sendJson(res, 403, { error: "only the session owner can approve" });
      }
      if (!pending) {
        return sendJson(res, 409, { error: "no pending control request" });
      }
      clearPendingRequest(sessionId);
      controlBySession.set(sessionId, {
        controllerId: pending.requesterId,
        roomId,
        grantedAt: Date.now(),
      });
      console.log(
        `[tandem-server] control of session ${sessionId} granted to ` +
          `${pending.requesterId} by owner ${userId}`
      );
      await mirrorControl(roomId, sessionId, {
        controllerId: pending.requesterId,
        pendingRequesterId: null,
        pendingRequestedAt: null,
      });
      return sendJson(res, 200, { controllerId: pending.requesterId });
    }

    case "deny": {
      if (userId !== ownerId) {
        return sendJson(res, 403, { error: "only the session owner can deny" });
      }
      if (!pending) {
        return sendJson(res, 409, { error: "no pending control request" });
      }
      clearPendingRequest(sessionId);
      console.log(
        `[tandem-server] control request for session ${sessionId} denied by owner`
      );
      await mirrorControl(roomId, sessionId, {
        controllerId: null,
        pendingRequesterId: null,
        pendingRequestedAt: null,
      });
      return sendJson(res, 200, { denied: true });
    }

    case "release": {
      const isController = !!control && control.controllerId === userId;
      if (!isController && userId !== ownerId) {
        return sendJson(res, 403, {
          error: "only the current controller or the session owner can release",
        });
      }
      // Idempotent: releasing when nothing is held is a no-op success.
      await releaseControl(
        sessionId,
        userId === ownerId ? `revoked by owner ${userId}` : `released by controller`
      );
      return sendJson(res, 200, { released: true });
    }

    default:
      return sendJson(res, 404, { error: "not found" });
  }
}

// ─── Activity endpoint (Stage 11) ────────────────────────────────────────────
// Room-wide "who's doing what": all currently-active real sessions (branch
// copies excluded — they're static) with owner email and latest summary,
// sorted by most recently updated. Consumed by tandem-cli at startup to
// inject teammate context into the generated memory file.

async function handleActivity(
  res: import("node:http").ServerResponse,
  roomId: string,
  userId: string
) {
  if (!(await isRoomMember(roomId, userId))) {
    return sendJson(res, 403, { error: "not a member of this room" });
  }
  const { data: sessions, error } = await supabase
    .from("sessions")
    .select("id, user_id, status, started_at, last_summary, last_summary_at")
    .eq("room_id", roomId)
    .eq("status", "active")
    .is("parent_session_id", null)
    .order("last_summary_at", { ascending: false, nullsFirst: false });
  if (error) return sendJson(res, 500, { error: error.message });

  const userIds = [...new Set((sessions ?? []).map((s) => s.user_id))];
  const { data: profiles } = userIds.length
    ? await supabase.from("profiles").select("id, email").in("id", userIds)
    : { data: [] };
  const emailById = Object.fromEntries(
    (profiles ?? []).map((p) => [p.id, p.email])
  );

  sendJson(res, 200, {
    sessions: (sessions ?? []).map((s) => ({
      sessionId: s.id,
      userId: s.user_id,
      email: emailById[s.user_id] ?? s.user_id,
      startedAt: s.started_at,
      lastSummary: s.last_summary,
      lastSummaryAt: s.last_summary_at,
      connected: cliSocketBySession.has(s.id),
    })),
  });
}

// ─── HTTP routing ────────────────────────────────────────────────────────────

const UUID = "[0-9a-fA-F-]{36}";
const MEMORY_COLLECTION = new RegExp(`^/rooms/(${UUID})/memory$`);
const MEMORY_ENTRY = new RegExp(`^/rooms/(${UUID})/memory/(${UUID})$`);
const CHAT_COLLECTION = new RegExp(`^/rooms/(${UUID})/chat$`);
const ACTIVITY = new RegExp(`^/rooms/(${UUID})/activity$`);
const CONTROL_ACTION = new RegExp(
  `^/sessions/(${UUID})/control/(request|approve|deny|release)$`
);

const httpServer = createServer((req, res) => {
  const route = async () => {
    const url = (req.url ?? "").split("?")[0];

    if (req.method === "POST" && url === "/branch") {
      return handleBranch(req, res);
    }

    // Debug-only call-volume counter (no auth: a bare integer, nothing more).
    if (req.method === "GET" && url === "/debug/summaries") {
      return sendJson(res, 200, { summaryCalls: summaryCallCount });
    }

    const activity = url.match(ACTIVITY);
    if (activity && req.method === "GET") {
      const userId = await authUser(req, res);
      if (!userId) return;
      return handleActivity(res, activity[1], userId);
    }

    const controlMatch = url.match(CONTROL_ACTION);
    if (controlMatch && req.method === "POST") {
      const userId = await authUser(req, res);
      if (!userId) return;
      return handleControl(res, controlMatch[1], controlMatch[2], userId);
    }

    const collection = url.match(MEMORY_COLLECTION);
    const entry = url.match(MEMORY_ENTRY);
    const chat = url.match(CHAT_COLLECTION);
    if (collection || entry || chat) {
      const userId = await authUser(req, res);
      if (!userId) return;
      if (collection && req.method === "GET") {
        return handleMemoryList(res, collection[1], userId);
      }
      if (collection && req.method === "POST") {
        return handleMemoryCreate(req, res, collection[1], userId);
      }
      if (entry && req.method === "DELETE") {
        return handleMemoryDelete(res, entry[1], entry[2], userId);
      }
      if (chat && req.method === "POST") {
        return handleChatCreate(req, res, chat[1], userId);
      }
    }

    sendJson(res, 404, { error: "not found" });
  };
  route().catch((err) => {
    console.error(`[tandem-server] http error: ${err?.message ?? err}`);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  });
});

const wss = new WebSocketServer({ server: httpServer });

// ─── Heartbeat ───────────────────────────────────────────────────────────────
// An abrupt network drop (e.g. wifi cut) sends no close frame, so without
// pings the socket — and its session — would stay "active" until the OS TCP
// timeout. Ping every 15s; a peer that misses one round is terminated, which
// fires "close" and ends the session normally.

const HEARTBEAT_INTERVAL_MS = 15_000;
const aliveSockets = new WeakSet<WebSocket>();

setInterval(() => {
  for (const client of wss.clients) {
    if (!aliveSockets.has(client)) {
      client.terminate();
      continue;
    }
    aliveSockets.delete(client);
    client.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

/** Browser connection auth: verifies identity + membership. Creates NO
    session row — web connections exist only to carry control input. */
async function handleWebAuth(
  ws: WebSocket,
  msg: AuthMessage
): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser(msg.token);
  if (error || !data.user) {
    ws.close(CLOSE_AUTH_FAILED, "invalid token");
    return null;
  }
  if (data.user.id !== msg.userId) {
    ws.close(CLOSE_AUTH_FAILED, "token does not match userId");
    return null;
  }
  if (!(await isRoomMember(msg.roomId, msg.userId))) {
    ws.close(CLOSE_AUTH_FAILED, "not a member of this room");
    return null;
  }
  let set = webSocketsByUser.get(msg.userId);
  if (!set) {
    set = new Set();
    webSocketsByUser.set(msg.userId, set);
  }
  set.add(ws);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "auth_ok" }));
  }
  return msg.userId;
}

/** SECURITY-CRITICAL: re-verify the sender against the CURRENT controller in
    server memory on EVERY message. Unauthorized input is silently dropped
    (logged server-side) so control state is not leaked to probers. */
function handleSessionInput(webUserId: string, msg: SessionInputMessage): void {
  if (typeof msg.sessionId !== "string" || typeof msg.content !== "string") {
    return;
  }
  if (msg.content.length > 4096) return; // keystrokes, not payload dumps
  const control = controlBySession.get(msg.sessionId);
  if (!control || control.controllerId !== webUserId) {
    console.warn(
      `[tandem-server] dropped session_input from ${webUserId} for session ` +
        `${msg.sessionId} — not the current controller`
    );
    return;
  }
  const cliWs = cliSocketBySession.get(msg.sessionId);
  if (cliWs && cliWs.readyState === WebSocket.OPEN) {
    cliWs.send(JSON.stringify({ type: "input", content: msg.content }));
  }
}

wss.on("connection", (ws) => {
  let state: ConnectionState | null = null;
  let webUserId: string | null = null;

  aliveSockets.add(ws);
  ws.on("pong", () => aliveSockets.add(ws));

  // Process messages sequentially so auth always completes before events,
  // and events are inserted in arrival order.
  let queue: Promise<void> = Promise.resolve();

  ws.on("message", (raw) => {
    queue = queue.then(async () => {
      // Do NOT skip processing when the socket has since closed: messages
      // received while open may still be queued behind slow DB writes when
      // the client disconnects, and dropping them here would lose the tail
      // of the session (e.g. events sent right before the CLI exits).

      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(CLOSE_PROTOCOL_ERROR, "invalid JSON");
        return;
      }

      if (!state && !webUserId) {
        if (msg.type !== "auth") {
          ws.close(CLOSE_PROTOCOL_ERROR, "expected auth message first");
          return;
        }
        if (msg.role === "web") {
          webUserId = await handleWebAuth(ws, msg);
        } else {
          // handleAuth registers the socket in cliSocketBySession itself,
          // before sending auth_ok (avoids a control-request race).
          state = await handleAuth(ws, msg);
        }
        return;
      }

      if (webUserId) {
        if (msg.type !== "session_input") {
          ws.close(CLOSE_PROTOCOL_ERROR, `unexpected message type: ${msg.type}`);
          return;
        }
        handleSessionInput(webUserId, msg);
        return;
      }

      if (msg.type !== "event") {
        ws.close(CLOSE_PROTOCOL_ERROR, `unexpected message type: ${msg.type}`);
        return;
      }
      await handleEvent(state!, msg);
    });
  });

  ws.on("close", () => {
    queue = queue.then(async () => {
      if (state) {
        // Session over: nothing left to control, nothing left to summarize.
        cliSocketBySession.delete(state.sessionId);
        summaryStopSession(state.sessionId);
        await releaseControl(state.sessionId, "session CLI disconnected");
        await endSession(state);
        state = null;
      }
      if (webUserId) {
        const set = webSocketsByUser.get(webUserId);
        set?.delete(ws);
        if (set && set.size === 0) {
          webSocketsByUser.delete(webUserId);
          // Controller's last browser connection is gone — auto-release
          // every session they were controlling.
          for (const [sessionId, control] of controlBySession) {
            if (control.controllerId === webUserId) {
              await releaseControl(sessionId, "controller browser disconnected");
            }
          }
        }
        webUserId = null;
      }
    });
  });

  ws.on("error", (err) => {
    console.error(`[tandem-server] connection error: ${err.message}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `[tandem-server] listening on ws://localhost:${PORT} ` +
      `(POST /branch on the same port)`
  );
});
