// Stage 5 e2e: branching.
//   - user A streams a live session (5 events)
//   - user B (a different room member) branches it at event 3 WHILE it is
//     still streaming, then A sends 2 more events
//   - assertions: branch owned by B with parent_session_id set, exactly the
//     first 3 events copied, source untouched (7 events, still its own),
//     Liveblocks mirror seeded, and auth rules enforced (non-member 403).
//
// Prerequisite: tandem-server must already be running. Run:
//   node test/e2e-stage5-branch.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Liveblocks } from "@liveblocks/node";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "..", ".env") });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LIVEBLOCKS_SECRET_KEY } =
  process.env;
const PORT = Number(process.env.PORT ?? 8787);
const BRANCH_URL = `http://localhost:${PORT}/branch`;

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
  let { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    const { error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr && !/already/i.test(createErr.message)) {
      fatal(`could not create ${email}: ${createErr.message}`);
    }
    ({ data, error } = await client.auth.signInWithPassword({ email, password }));
    if (error) fatal(`could not sign in ${email}: ${error.message}`);
  }
  return { userId: data.user.id, token: data.session.access_token };
}

function asUser(token) {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function postBranch(token, body) {
  const res = await fetch(BRANCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// ─── setup ───────────────────────────────────────────────────────────────────

const a = await signIn(USER_A);
const b = await signIn(USER_B);

const inviteCode = "B5" + Math.random().toString(36).slice(2, 8).toUpperCase();
const { data: roomId, error: roomErr } = await asUser(a.token).rpc("create_room", {
  p_name: "e2e-branch-room",
  p_invite_code: inviteCode,
});
if (roomErr) fatal(`create_room failed: ${roomErr.message}`);
console.log(`room: ${roomId}`);

// ─── user A streams a live session ───────────────────────────────────────────

const sourceSessionId = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const timer = setTimeout(() => reject(new Error("auth_ok timeout")), 5000);
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "auth", roomId, userId: a.userId, token: a.token })
    )
  );
  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "auth_ok") return;
    clearTimeout(timer);
    const base = Date.now();
    for (let i = 1; i <= 5; i++) {
      ws.send(
        JSON.stringify({
          type: "event",
          sessionId: msg.sessionId,
          eventType: "output",
          content: `source line ${i}\n`,
          timestamp: new Date(base + i).toISOString(),
        })
      );
    }
    // Session A stays OPEN — the branch happens mid-stream. Give the server
    // a moment to flush the first 5 events, branch, then send 2 more.
    globalThis.__sourceWs = ws;
    globalThis.__sourceBase = base;
    resolve(msg.sessionId);
  });
  ws.on("error", reject);
});
console.log(`source session: ${sourceSessionId}`);
await sleep(2500); // let the 5 events land durably

// ─── auth checks before the real branch ──────────────────────────────────────

const noToken = await postBranch(null, { sourceSessionId, eventCount: 3 });
check("branch without token is rejected (401)", noToken.status === 401);

const notMember = await postBranch(b.token, { sourceSessionId, eventCount: 3 });
check(
  "branch by non-member is rejected (403)",
  notMember.status === 403,
  `got ${notMember.status}`
);

// B joins the room, then branches A's still-streaming session at event 3.
const { error: joinErr } = await asUser(b.token).rpc("join_room_by_invite_code", {
  p_invite_code: inviteCode,
});
if (joinErr) fatal(`join failed: ${joinErr.message}`);

const branched = await postBranch(b.token, { sourceSessionId, eventCount: 3 });
check(
  "member can branch a teammate's session",
  branched.status === 200 && typeof branched.json.sessionId === "string",
  `got ${branched.status}: ${JSON.stringify(branched.json)}`
);
const branchId = branched.json.sessionId;
console.log(`branch session: ${branchId}`);

// Source keeps streaming AFTER the branch point.
const ws = globalThis.__sourceWs;
const base = globalThis.__sourceBase;
for (let i = 6; i <= 7; i++) {
  ws.send(
    JSON.stringify({
      type: "event",
      sessionId: sourceSessionId,
      eventType: "output",
      content: `source line ${i}\n`,
      timestamp: new Date(base + i).toISOString(),
    })
  );
}
ws.close(1000);
await sleep(2500); // let the tail + end-of-session land

// ─── assertions ──────────────────────────────────────────────────────────────

const { data: branchRow } = await admin
  .from("sessions")
  .select("room_id, user_id, parent_session_id, status")
  .eq("id", branchId)
  .maybeSingle();
check(
  "branch row: owned by the CLICKING user (B)",
  branchRow?.user_id === b.userId,
  `got ${branchRow?.user_id}`
);
check(
  "branch row: parent_session_id points at source",
  branchRow?.parent_session_id === sourceSessionId,
  `got ${branchRow?.parent_session_id}`
);
check("branch row: same room", branchRow?.room_id === roomId);
check("branch row: status active", branchRow?.status === "active");

const { data: branchEvents } = await admin
  .from("session_events")
  .select("content")
  .eq("session_id", branchId)
  .order("created_at", { ascending: true });
check(
  "branch has exactly the first 3 events (moment-of-click copy)",
  JSON.stringify(branchEvents?.map((e) => e.content)) ===
    JSON.stringify(["source line 1\n", "source line 2\n", "source line 3\n"]),
  `got ${JSON.stringify(branchEvents?.map((e) => e.content))}`
);

const { data: sourceEvents } = await admin
  .from("session_events")
  .select("content")
  .eq("session_id", sourceSessionId)
  .order("created_at", { ascending: true });
check(
  "source session untouched: all 7 events, in order",
  JSON.stringify(sourceEvents?.map((e) => e.content)) ===
    JSON.stringify(Array.from({ length: 7 }, (_, i) => `source line ${i + 1}\n`)),
  `got ${sourceEvents?.length} events`
);
const { data: sourceRow } = await admin
  .from("sessions")
  .select("user_id, parent_session_id, status")
  .eq("id", sourceSessionId)
  .single();
check(
  "source session still owned by A with no parent",
  sourceRow?.user_id === a.userId && sourceRow?.parent_session_id === null
);

// Liveblocks mirror of the branch.
if (LIVEBLOCKS_SECRET_KEY) {
  const lb = new Liveblocks({ secret: LIVEBLOCKS_SECRET_KEY });
  const doc = await lb.getStorageDocument(`tandem-room-${roomId}`, "json");
  const entry = doc?.sessions?.[branchId];
  check(
    "Liveblocks: branch entry seeded with 3 events + lineage",
    entry?.parentSessionId === sourceSessionId &&
      entry?.events?.length === 3 &&
      entry?.userId === b.userId,
    `got ${JSON.stringify(entry)?.slice(0, 200)}`
  );
} else {
  console.log("SKIP  Liveblocks assertion (no key)");
}

// ─── cleanup ─────────────────────────────────────────────────────────────────

const { data: allSessions } = await admin
  .from("sessions")
  .select("id")
  .eq("room_id", roomId);
const ids = (allSessions ?? []).map((s) => s.id);
if (ids.length) await admin.from("session_events").delete().in("session_id", ids);
await admin.from("rooms").delete().eq("id", roomId); // cascades sessions+members
console.log("\ncleanup: removed test room, sessions, and events");

summarize();
process.exit(failed === 0 ? 0 : 1);
