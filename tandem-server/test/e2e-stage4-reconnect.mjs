// Stage 4 e2e: server-side reconnect behavior.
//   1. A client auths, streams events, then drops ABRUPTLY (terminate, no
//      close frame) — simulating a network drop.
//   2. A reconnect follows immediately with the same roomId/userId; the
//      server must issue a fresh session (no merging).
//   3. Both sessions must end up status "ended" in Supabase, each with the
//      events it received.
//
// Prerequisite: tandem-server must already be running. Run:
//   node test/e2e-stage4-reconnect.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "..", ".env") });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const PORT = Number(process.env.PORT ?? 8787);
const TEST_EMAIL = "test-e2e@tandem.dev";
const TEST_PASSWORD = "testpassword123";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function summarize() {
  console.log(`\n${passed}/${passed + failed} checks passed`);
}
function fatal(message) {
  console.error(`FATAL ${message}`);
  summarize();
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── setup: user + room (same pattern as Stage 2 e2e) ────────────────────────

const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data: signIn, error: signInErr } = await authClient.auth.signInWithPassword({
  email: TEST_EMAIL,
  password: TEST_PASSWORD,
});
if (signInErr) fatal(`sign-in failed: ${signInErr.message}`);
const token = signIn.session.access_token;
const userId = signIn.user.id;

const asUser = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${token}` } },
});
const { data: roomId, error: roomErr } = await asUser.rpc("create_room", {
  p_name: "e2e-reconnect-room",
  p_invite_code: "R4" + Math.random().toString(36).slice(2, 8).toUpperCase(),
});
if (roomErr) fatal(`create_room failed: ${roomErr.message}`);
console.log(`room: ${roomId}`);

// ─── websocket helpers ────────────────────────────────────────────────────────

function openSession() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out waiting for auth_ok"));
    }, 5000);
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "auth", roomId, userId, token }))
    );
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_ok") {
        clearTimeout(timer);
        resolve({ ws, sessionId: msg.sessionId });
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendEvent(ws, sessionId, content) {
  ws.send(
    JSON.stringify({
      type: "event",
      sessionId,
      eventType: "output",
      content,
      timestamp: new Date().toISOString(),
    })
  );
}

async function pollSessionEnded(sessionId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let session = null;
  do {
    ({ data: session } = await admin
      .from("sessions")
      .select("id, status, ended_at")
      .eq("id", sessionId)
      .maybeSingle());
    if (session?.status === "ended") return session;
    await sleep(250);
  } while (Date.now() < deadline);
  return session;
}

// ─── scenario ────────────────────────────────────────────────────────────────

// Session 1: stream, then drop abruptly (no close frame).
const s1 = await openSession();
console.log(`session 1: ${s1.sessionId}`);
sendEvent(s1.ws, s1.sessionId, "before drop 1");
sendEvent(s1.ws, s1.sessionId, "before drop 2");
await sleep(100); // let sends hit the wire before killing the socket
s1.ws.terminate(); // abrupt: destroys the TCP socket, no close handshake

// Reconnect within the "short window" — server should just issue a new session.
const s2 = await openSession();
console.log(`session 2: ${s2.sessionId}`);
check("reconnect gets a NEW sessionId (no merging)", s2.sessionId !== s1.sessionId);

sendEvent(s2.ws, s2.sessionId, "after reconnect 1");
s2.ws.close(1000, "session ended");

// ─── assertions ──────────────────────────────────────────────────────────────

const ended1 = await pollSessionEnded(s1.sessionId);
check(
  "dropped session marked ended in Supabase",
  ended1?.status === "ended" && ended1?.ended_at != null,
  `got status=${ended1?.status} ended_at=${ended1?.ended_at}`
);

const ended2 = await pollSessionEnded(s2.sessionId);
check(
  "reconnected session marked ended after clean exit",
  ended2?.status === "ended" && ended2?.ended_at != null,
  `got status=${ended2?.status} ended_at=${ended2?.ended_at}`
);

const { data: ev1 } = await admin
  .from("session_events")
  .select("content")
  .eq("session_id", s1.sessionId)
  .order("created_at", { ascending: true });
check(
  "pre-drop events persisted to dropped session",
  JSON.stringify(ev1?.map((e) => e.content)) ===
    JSON.stringify(["before drop 1", "before drop 2"]),
  `got ${JSON.stringify(ev1?.map((e) => e.content))}`
);

const { data: ev2 } = await admin
  .from("session_events")
  .select("content")
  .eq("session_id", s2.sessionId);
check(
  "post-reconnect events persisted to new session",
  JSON.stringify(ev2?.map((e) => e.content)) === JSON.stringify(["after reconnect 1"]),
  `got ${JSON.stringify(ev2?.map((e) => e.content))}`
);

// ─── cleanup ─────────────────────────────────────────────────────────────────

await admin.from("session_events").delete().in("session_id", [s1.sessionId, s2.sessionId]);
await admin.from("sessions").delete().in("id", [s1.sessionId, s2.sessionId]);
await admin.from("rooms").delete().eq("id", roomId);
console.log("\ncleanup: removed test sessions, events, and room");

summarize();
process.exit(failed === 0 ? 0 : 1);
