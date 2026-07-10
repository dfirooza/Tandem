import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { WebSocketServer, WebSocket } from "ws";

// ─── Config ──────────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
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
  return { userId: msg.userId, roomId: msg.roomId, sessionId: session.id };
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
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  let state: ConnectionState | null = null;

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

console.log(`[tandem-server] listening on ws://localhost:${PORT}`);
