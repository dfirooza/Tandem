// Stage 11 e2e: auto-summarization.
//   - an active session with new events gets summarized (durable + Liveblocks)
//   - idle sessions are SKIPPED (no API call — cost gate)
//   - ⚠️ TIMER LIFECYCLE: ending a session stops its summarization — the
//     call counter must not increment after the CLI disconnects. This is the
//     cost-critical check (Stage 4's orphan-session lesson).
//   - GET /rooms/:id/activity: auth rules + owner email + summary payload
//
// Prerequisites: ANTHROPIC_API_KEY set, migration 004 applied, and the
// server started with a short interval, matching this test:
//   CONTROL_REQUEST_TIMEOUT_MS=5000 SUMMARY_INTERVAL_MS=3000 node dist/index.js
//   SUMMARY_INTERVAL_MS=3000 node test/e2e-stage11-summary.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Liveblocks } from "@liveblocks/node";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "..", ".env") });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LIVEBLOCKS_SECRET_KEY } = process.env;
const PORT = Number(process.env.PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;
const INTERVAL = Number(process.env.SUMMARY_INTERVAL_MS ?? 3000);

const USER_A = { email: "test-e2e@tandem.dev", password: "testpassword123" };
const USER_B = { email: "test-e2e-b@tandem.dev", password: "testpassword123" };

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

async function signIn({ email, password }) {
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) fatal(`could not sign in ${email}: ${error.message}`);
  return { userId: data.user.id, token: data.session.access_token };
}

function asUser(token) {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function summaryCalls() {
  const res = await fetch(`${BASE}/debug/summaries`);
  return (await res.json()).summaryCalls;
}

/** Polls until the call counter reaches `target` (tick + API latency vary). */
async function waitForCalls(target, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let calls = await summaryCalls();
  while (calls < target && Date.now() < deadline) {
    await sleep(400);
    calls = await summaryCalls();
  }
  return calls;
}

function openCliSession(roomId, user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timer = setTimeout(() => reject(new Error("auth_ok timeout")), 5000);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({ type: "auth", roomId, userId: user.userId, token: user.token })
      )
    );
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_ok") {
        clearTimeout(timer);
        resolve({ ws, sessionId: msg.sessionId });
      }
    });
    ws.on("error", reject);
  });
}

function sendOutput(ws, sessionId, content) {
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

// ─── setup ───────────────────────────────────────────────────────────────────

const a = await signIn(USER_A);
const b = await signIn(USER_B);

const inviteCode = "S11" + Math.random().toString(36).slice(2, 7).toUpperCase();
const { data: roomId, error: roomErr } = await asUser(a.token).rpc("create_room", {
  p_name: "e2e-summary-room",
  p_invite_code: inviteCode,
});
if (roomErr) fatal(`create_room failed: ${roomErr.message}`);
console.log(`room: ${roomId} (interval: ${INTERVAL}ms)`);

const cli = await openCliSession(roomId, a);
console.log(`session: ${cli.sessionId}`);

// ─── summarization of an active session ─────────────────────────────────────

const calls0 = await summaryCalls();

// Realistic transcript so relevance can be judged from the logged summary.
sendOutput(cli.ws, cli.sessionId, "> fix the flaky retry logic in src/net/reconnect.ts\n");
sendOutput(
  cli.ws,
  cli.sessionId,
  "Reading src/net/reconnect.ts... The backoff timer is reset on every " +
    "error event, so parallel errors collapse the delay to zero.\n"
);
sendOutput(
  cli.ws,
  cli.sessionId,
  "Editing src/net/reconnect.ts: guarding scheduleReconnect() so only the " +
    "first drop arms the timer. Running npm test...\n✓ reconnect.test.ts (14 tests)\n"
);

const calls1 = await waitForCalls(calls0 + 1);
check("active session with new events got summarized (1 API call)", calls1 === calls0 + 1, `calls ${calls0} -> ${calls1}`);
await sleep(1000); // let the Supabase/Liveblocks writes land

const { data: row1 } = await admin
  .from("sessions")
  .select("last_summary, last_summary_at")
  .eq("id", cli.sessionId)
  .single();
check(
  "summary stored in Supabase (non-empty, plausible length)",
  typeof row1?.last_summary === "string" &&
    row1.last_summary.length > 5 &&
    row1.last_summary.length < 250 &&
    row1.last_summary_at !== null,
  JSON.stringify(row1)
);
console.log(`      summary: "${row1?.last_summary}"`);

if (LIVEBLOCKS_SECRET_KEY) {
  const lb = new Liveblocks({ secret: LIVEBLOCKS_SECRET_KEY });
  const doc = await lb.getStorageDocument(`tandem-room-${roomId}`, "json");
  check(
    "summary mirrored to Liveblocks",
    doc?.sessions?.[cli.sessionId]?.lastSummary === row1?.last_summary
  );
} else {
  console.log("SKIP  Liveblocks assertion (no key)");
}

// ─── idle sessions are skipped ───────────────────────────────────────────────

await sleep(INTERVAL * 2 + 1500); // two full ticks with no new events
const calls2 = await summaryCalls();
check("idle session skipped (no API call without new events)", calls2 === calls1, `calls ${calls1} -> ${calls2}`);

// New events re-arm it.
sendOutput(cli.ws, cli.sessionId, "> now add a unit test for the double-drop case\nWriting test...\n");
const calls3 = await waitForCalls(calls2 + 1);
check("new events re-arm summarization", calls3 === calls2 + 1, `calls ${calls2} -> ${calls3}`);
await sleep(1000); // let the writes land before reading activity

// ─── activity endpoint ───────────────────────────────────────────────────────

const noAuth = await fetch(`${BASE}/rooms/${roomId}/activity`);
check("activity without token → 401", noAuth.status === 401);

const nonMember = await fetch(`${BASE}/rooms/${roomId}/activity`, {
  headers: { Authorization: `Bearer ${b.token}` },
});
check("activity for non-member → 403", nonMember.status === 403, `got ${nonMember.status}`);

const activityRes = await fetch(`${BASE}/rooms/${roomId}/activity`, {
  headers: { Authorization: `Bearer ${a.token}` },
});
const activity = await activityRes.json();
const mine = activity.sessions?.find((s) => s.sessionId === cli.sessionId);
check(
  "activity lists the active session with email + summary",
  activityRes.status === 200 &&
    mine?.email === USER_A.email &&
    typeof mine?.lastSummary === "string" &&
    mine?.connected === true,
  JSON.stringify(activity).slice(0, 300)
);

// ─── ⚠️ TIMER LIFECYCLE: session end stops summarization ─────────────────────

// Queue unsummarized events, then disconnect BEFORE the next tick: the dirty
// state must die with the session, not fire one last (or worse, recurring)
// API call.
sendOutput(cli.ws, cli.sessionId, "> final output right before exit\n");
await sleep(300); // let the event land, but not a full tick
cli.ws.close(1000);
await sleep(1500); // server marks session ended

const callsAtEnd = await summaryCalls();
await sleep(INTERVAL * 2 + 2000); // two full ticks after the session ended
const callsAfter = await summaryCalls();
check(
  "TIMER: no summarization calls after session end (leak check)",
  callsAfter === callsAtEnd,
  `calls ${callsAtEnd} -> ${callsAfter} across 2 post-end intervals`
);

const activityAfter = await fetch(`${BASE}/rooms/${roomId}/activity`, {
  headers: { Authorization: `Bearer ${a.token}` },
});
const after = await activityAfter.json();
check(
  "ended session no longer listed in activity",
  !after.sessions?.some((s) => s.sessionId === cli.sessionId)
);

// ─── cleanup ─────────────────────────────────────────────────────────────────

await admin.from("session_events").delete().eq("session_id", cli.sessionId);
await admin.from("rooms").delete().eq("id", roomId);
console.log("\ncleanup: removed test room and session");

summarize();
process.exit(failed === 0 ? 0 : 1);
