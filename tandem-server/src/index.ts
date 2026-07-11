import "dotenv/config";
import { createServer } from "node:http";
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
  events: LiveList<{ eventType: string; content: string; timestamp: string }>;
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
  event: { eventType: string; content: string; timestamp: string }
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
  roomId: string;
  userId: string;
  token: string;
}

interface EventMessage {
  type: "event";
  sessionId: string;
  eventType: string;
  content: string;
  timestamp: string;
}

type ClientMessage = AuthMessage | EventMessage;

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

  // The socket may have closed while the writes above were in flight; the
  // session row still exists and the close handler will mark it ended.
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "auth_ok", sessionId: session.id }));
  }
  console.log(
    `[tandem-server] session ${session.id} started ` +
      `(user ${msg.userId}, room ${msg.roomId})`
  );
  const state: ConnectionState = {
    userId: msg.userId,
    roomId: msg.roomId,
    sessionId: session.id,
  };
  await liveSessionStart(state);
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
    timestamp: msg.timestamp,
  });
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

async function handleBranch(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return sendJson(res, 401, { error: "missing bearer token" });

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData.user) {
    return sendJson(res, 401, { error: "invalid token" });
  }
  const userId = userData.user.id;

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

  const { data: membership } = await supabase
    .from("room_members")
    .select("user_id")
    .eq("room_id", source.room_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!membership) {
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
}

const httpServer = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/branch") {
    handleBranch(req, res).catch((err) => {
      console.error(`[tandem-server] branch failed: ${err?.message ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
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

wss.on("connection", (ws) => {
  let state: ConnectionState | null = null;

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

      if (!state) {
        if (msg.type !== "auth") {
          ws.close(CLOSE_PROTOCOL_ERROR, "expected auth message first");
          return;
        }
        state = await handleAuth(ws, msg);
        return;
      }

      if (msg.type !== "event") {
        ws.close(CLOSE_PROTOCOL_ERROR, `unexpected message type: ${msg.type}`);
        return;
      }
      await handleEvent(state, msg);
    });
  });

  ws.on("close", () => {
    queue = queue.then(async () => {
      if (state) {
        await endSession(state);
        state = null;
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
