// End-to-end integration test for the Stage 2 pipeline:
//   CLI (simulated) → tandem-server (WebSocket) → Supabase (durable writes)
//
// Prerequisite: tandem-server must already be running (npm start) — this
// test does NOT start it.
//
// Run: node test/e2e-stage2.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

// ─── Config ──────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "..", ".env") });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const PORT = Number(process.env.PORT ?? 8787);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in tandem-server/.env");
  process.exit(1);
}

const TEST_EMAIL = "test-e2e@tandem.dev";
const TEST_PASSWORD = "testpassword123";
const TEST_ROOM_NAME = "e2e-test-room";

// Service role client: admin operations + RLS-bypassing assertions.
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Check tracking ──────────────────────────────────────────────────────────

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

function fatal(message) {
  console.error(`FATAL ${message}`);
  summarize();
  process.exit(1);
}

function summarize() {
  console.log(`\n${passed}/${passed + failed} checks passed`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Step 1: test user + access token ────────────────────────────────────────

async function getTestUser() {
  // Sign in on a dedicated client: signInWithPassword() stores the user
  // session on the client it's called on, which would silently downgrade
  // all later `admin` queries from service_role to the authenticated user.
  const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Try signing in first; create the user only if that fails.
  let { data: signIn, error: signInErr } = await authClient.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  if (signInErr) {
    const { error: createErr } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (createErr && !/already/i.test(createErr.message)) {
      fatal(`could not create test user: ${createErr.message}`);
    }
    ({ data: signIn, error: signInErr } = await authClient.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    }));
    if (signInErr) fatal(`could not sign in as test user: ${signInErr.message}`);
  }

  return { userId: signIn.user.id, token: signIn.session.access_token };
}

// ─── Step 2: test room via create_room RPC ───────────────────────────────────

async function getTestRoom(userId, token) {
  const { data: existing, error: findErr } = await admin
    .from("rooms")
    .select("id")
    .eq("created_by", userId)
    .eq("name", TEST_ROOM_NAME)
    .limit(1);
  if (findErr) fatal(`could not query rooms: ${findErr.message}`);
  if (existing?.length) return existing[0].id;

  // create_room uses auth.uid(), so it must run as the user, not service role.
  const asUser = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const inviteCode = "E2E" + Math.random().toString(36).slice(2, 7).toUpperCase();
  const { data: roomId, error: rpcErr } = await asUser.rpc("create_room", {
    p_name: TEST_ROOM_NAME,
    p_invite_code: inviteCode,
  });
  if (rpcErr) fatal(`create_room RPC failed: ${rpcErr.message}`);
  return roomId;
}

// ─── Step 3: WebSocket session (simulating tandem-cli) ───────────────────────

function runWebSocketSession(roomId, userId, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out waiting for auth_ok (5s)"));
    }, 5000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", roomId, userId, token }));
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== "auth_ok") return;
      clearTimeout(timer);

      const base = Date.now();
      for (let i = 1; i <= 3; i++) {
        ws.send(
          JSON.stringify({
            type: "event",
            sessionId: msg.sessionId,
            eventType: "output",
            content: `test chunk ${i}`,
            // Distinct increasing timestamps so insertion order is preserved.
            timestamp: new Date(base + i).toISOString(),
          })
        );
      }
      ws.close();
      resolve(msg.sessionId);
    });

    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      reject(new Error(`socket closed before auth_ok (code ${code}: ${reason})`));
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`websocket error: ${err.message}`));
    });
  });
}

// ─── Steps 5–6: assertions + cleanup ─────────────────────────────────────────

async function main() {
  const { userId, token } = await getTestUser();
  console.log(`test user: ${userId}`);

  const roomId = await getTestRoom(userId, token);
  console.log(`test room: ${roomId}`);

  let sessionId;
  try {
    sessionId = await runWebSocketSession(roomId, userId, token);
  } catch (err) {
    fatal(`websocket session failed: ${err.message}`);
  }
  console.log(`session:   ${sessionId}\n`);

  // Give the server time to flush its writes after the disconnect. The
  // server processes its queue sequentially (3 inserts + the ended update,
  // each a network round-trip), so after the initial 500ms grace period,
  // poll for the final write (status = "ended") for up to 10s.
  await sleep(500);
  let session = null;
  let sessionErr = null;
  const deadline = Date.now() + 10_000;
  do {
    ({ data: session, error: sessionErr } = await admin
      .from("sessions")
      .select("id, room_id, user_id, status, ended_at")
      .eq("id", sessionId)
      .maybeSingle());
    if (session?.status === "ended") break;
    await sleep(250);
  } while (Date.now() < deadline);

  check("sessions row exists", !!session, sessionErr?.message ?? "no row found");
  check(
    "session has correct room_id",
    session?.room_id === roomId,
    `got ${session?.room_id}`
  );
  check(
    "session has correct user_id",
    session?.user_id === userId,
    `got ${session?.user_id}`
  );
  check(
    'session status is "ended"',
    session?.status === "ended",
    `got "${session?.status}"`
  );
  check("session ended_at is non-null", session?.ended_at != null, "ended_at is null");

  const { data: events, error: eventsErr } = await admin
    .from("session_events")
    .select("type, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  check(
    "exactly 3 session_events rows",
    !eventsErr && events?.length === 3,
    eventsErr?.message ?? `got ${events?.length ?? 0}`
  );
  const expected = ["test chunk 1", "test chunk 2", "test chunk 3"];
  check(
    "event contents match in order",
    JSON.stringify((events ?? []).map((e) => e.content)) === JSON.stringify(expected),
    `got ${JSON.stringify((events ?? []).map((e) => e.content))}`
  );

  // ─── Cleanup ────────────────────────────────────────────────────────────────
  const del1 = await admin.from("session_events").delete().eq("session_id", sessionId);
  const del2 = await admin.from("sessions").delete().eq("id", sessionId);
  // Deleting the room cascades to room_members.
  const del3 = await admin.from("rooms").delete().eq("id", roomId);
  const cleanupErr = del1.error ?? del2.error ?? del3.error;
  if (cleanupErr) {
    console.warn(`WARN  cleanup incomplete: ${cleanupErr.message}`);
  } else {
    console.log("\ncleanup: removed test session_events, session, and room");
  }

  summarize();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => fatal(err.stack ?? String(err)));
