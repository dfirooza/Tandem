// Stage 12 e2e: (A) room visibility — a non-member genuinely cannot see a
// room or its contents through ANY surface (RLS direct queries, every HTTP
// endpoint, both WebSocket auth modes); (B) one-time branch summaries.
//
// RLS checks use the ANON key + user JWT (the service key bypasses RLS and
// would prove nothing).
//
// Prerequisite: tandem-server running (default intervals fine). Run:
//   node test/e2e-stage12-visibility.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Liveblocks } from "@liveblocks/node";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "..", ".env") });

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY,
  LIVEBLOCKS_SECRET_KEY,
} = process.env;
const PORT = Number(process.env.PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;

if (!SUPABASE_ANON_KEY) {
  console.error("FATAL SUPABASE_ANON_KEY required — RLS checks are meaningless with the service key");
  process.exit(1);
}

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

/** ANON key + user JWT — real RLS enforcement, no service-role bypass. */
function asRlsUser(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function api(method, pathname, token, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** Opens a WS with the given auth message; resolves how it concluded. */
function tryWsAuth(authMsg) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ outcome: "timeout" });
    }, 5000);
    ws.on("open", () => ws.send(JSON.stringify(authMsg)));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_ok") {
        clearTimeout(timer);
        resolve({ outcome: "auth_ok", sessionId: msg.sessionId, ws });
      }
    });
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ outcome: "closed", code, reason: reason.toString() });
    });
    ws.on("error", () => {});
  });
}

// ─── setup: A's private room with a session, memory, and chat ────────────────

const a = await signIn(USER_A);
const b = await signIn(USER_B);

const { data: roomId, error: roomErr } = await asRlsUser(a.token).rpc("create_room", {
  p_name: "e2e-visibility-room",
  p_invite_code: "V12" + Math.random().toString(36).slice(2, 7).toUpperCase(),
});
if (roomErr) fatal(`create_room failed: ${roomErr.message}`);
console.log(`room (A only): ${roomId}`);

const cliAuth = await tryWsAuth({ type: "auth", roomId, userId: a.userId, token: a.token });
if (cliAuth.outcome !== "auth_ok") fatal(`A could not open a session: ${JSON.stringify(cliAuth)}`);
const sessionId = cliAuth.sessionId;
for (let i = 1; i <= 3; i++) {
  cliAuth.ws.send(
    JSON.stringify({
      type: "event",
      sessionId,
      eventType: "output",
      content: `> refactor the CSV export to stream rows instead of buffering (${i})\n`,
      timestamp: new Date().toISOString(),
    })
  );
}
await api("POST", `/rooms/${roomId}/memory`, a.token, { content: "secret decision", tags: [] });
await api("POST", `/rooms/${roomId}/chat`, a.token, { content: "secret message" });
await sleep(1500); // let writes land

// ─── A: RLS — B sees NOTHING via direct Supabase queries ────────────────────

const rls = asRlsUser(b.token);

const { data: roomList } = await rls.from("rooms").select("id");
check(
  "RLS: room absent from B's room list",
  !(roomList ?? []).some((r) => r.id === roomId),
  `B sees ${roomList?.length ?? 0} rooms`
);

const { data: direct } = await rls.from("rooms").select("id, name, invite_code").eq("id", roomId).maybeSingle();
check("RLS: direct fetch by room id returns nothing", direct === null, JSON.stringify(direct));

const { data: members } = await rls.from("room_members").select("user_id").eq("room_id", roomId);
check("RLS: room members invisible to non-member", (members ?? []).length === 0);

const { data: sess } = await rls.from("sessions").select("id").eq("room_id", roomId);
check("RLS: sessions invisible to non-member", (sess ?? []).length === 0);

const { data: evs } = await rls.from("session_events").select("id").eq("session_id", sessionId);
check("RLS: session events invisible to non-member", (evs ?? []).length === 0);

const { data: mem } = await rls.from("memory_entries").select("id").eq("room_id", roomId);
check("RLS: memory entries invisible to non-member", (mem ?? []).length === 0);

const { data: chat } = await rls.from("chat_messages").select("id").eq("room_id", roomId);
check("RLS: chat messages invisible to non-member", (chat ?? []).length === 0);

// ─── A: every tandem-server endpoint rejects the non-member ─────────────────

const endpoints = [
  ["GET", `/rooms/${roomId}/memory`, null],
  ["POST", `/rooms/${roomId}/memory`, { content: "x", tags: [] }],
  ["POST", `/rooms/${roomId}/chat`, { content: "x" }],
  ["GET", `/rooms/${roomId}/activity`, null],
  ["POST", "/branch", { sourceSessionId: sessionId, eventCount: 1 }],
  ["POST", `/sessions/${sessionId}/control/request`, null],
];
for (const [method, pathname, body] of endpoints) {
  const r = await api(method, pathname, b.token, body);
  check(`endpoint: non-member ${method} ${pathname.replace(roomId, ":room").replace(sessionId, ":session")} → 403`, r.status === 403, `got ${r.status}`);
}
const anon = await api("GET", `/rooms/${roomId}/activity`, null);
check("endpoint: anonymous → 401", anon.status === 401);

// ─── A: WebSocket auth modes reject the non-member ───────────────────────────

const bCli = await tryWsAuth({ type: "auth", roomId, userId: b.userId, token: b.token });
check(
  "WS: non-member CLI auth rejected (cannot plant a session in the room)",
  bCli.outcome === "closed" && bCli.code === 4001,
  JSON.stringify(bCli)
);
const { data: planted } = await admin
  .from("sessions")
  .select("id")
  .eq("room_id", roomId)
  .eq("user_id", b.userId);
check("WS: no session row was created for the rejected non-member", (planted ?? []).length === 0);

const bWeb = await tryWsAuth({ type: "auth", role: "web", roomId, userId: b.userId, token: b.token });
check(
  "WS: non-member web auth rejected",
  bWeb.outcome === "closed" && bWeb.code === 4001,
  JSON.stringify(bWeb)
);

// Sanity: the member is NOT locked out by any of this.
const aActivity = await api("GET", `/rooms/${roomId}/activity`, a.token);
check("sanity: member still has full access (activity 200)", aActivity.status === 200);

// ─── B: one-time branch summary ──────────────────────────────────────────────

const branchedA = await api("POST", "/branch", a.token, {
  sourceSessionId: sessionId,
  eventCount: 3,
});
const branchId = branchedA.json.sessionId;
check("branch created by member", branchedA.status === 200 && !!branchId, JSON.stringify(branchedA.json));

let branchRow = null;
const deadline = Date.now() + 25_000;
while (Date.now() < deadline) {
  ({ data: branchRow } = await admin
    .from("sessions")
    .select("last_summary, last_summary_at")
    .eq("id", branchId)
    .maybeSingle());
  if (branchRow?.last_summary) break;
  await sleep(500);
}
check(
  "branch got a one-time summary (durable)",
  typeof branchRow?.last_summary === "string" && branchRow.last_summary.length > 5,
  JSON.stringify(branchRow)
);
console.log(`      branch summary: "${branchRow?.last_summary}"`);

if (LIVEBLOCKS_SECRET_KEY) {
  // The backfill writes Supabase first, Liveblocks second — poll briefly.
  const lb = new Liveblocks({ secret: LIVEBLOCKS_SECRET_KEY });
  let mirrored = null;
  const lbDeadline = Date.now() + 10_000;
  while (Date.now() < lbDeadline) {
    const doc = await lb.getStorageDocument(`tandem-room-${roomId}`, "json");
    mirrored = doc?.sessions?.[branchId]?.lastSummary ?? null;
    if (mirrored) break;
    await sleep(500);
  }
  check(
    "branch summary mirrored to Liveblocks",
    mirrored === branchRow?.last_summary,
    `mirrored=${JSON.stringify(mirrored)}`
  );
} else {
  console.log("SKIP  Liveblocks assertion (no key)");
}

// ─── cleanup ─────────────────────────────────────────────────────────────────

cliAuth.ws.close(1000);
await sleep(1000);
const { data: allSessions } = await admin.from("sessions").select("id").eq("room_id", roomId);
const ids = (allSessions ?? []).map((s) => s.id);
if (ids.length) await admin.from("session_events").delete().in("session_id", ids);
await admin.from("rooms").delete().eq("id", roomId);
console.log("\ncleanup: removed test room and sessions");

summarize();
process.exit(failed === 0 ? 0 : 1);
