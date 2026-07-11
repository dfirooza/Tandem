// Stage 10 e2e: turn-based remote session control — including the
// SECURITY-CRITICAL path: session_input from anyone who is not the current
// controller must never reach the CLI.
//
// Prerequisite: tandem-server running. For the timeout check, start it with
// a short window and pass the same value to this test:
//   CONTROL_REQUEST_TIMEOUT_MS=5000 node dist/index.js
//   CONTROL_REQUEST_TIMEOUT_MS=5000 node test/e2e-stage10-control.mjs

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
const TIMEOUT_MS = Number(process.env.CONTROL_REQUEST_TIMEOUT_MS ?? 5000);

const USER_A = { email: "test-e2e@tandem.dev", password: "testpassword123" }; // owner
const USER_B = { email: "test-e2e-b@tandem.dev", password: "testpassword123" }; // requester
const USER_C = { email: "test-e2e-c@tandem.dev", password: "testpassword123" }; // attacker

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

async function api(pathname, token) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** Simulated CLI connection: records input messages the server forwards. */
function openCliSession(roomId, user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const receivedInput = [];
    const timer = setTimeout(() => reject(new Error("cli auth_ok timeout")), 5000);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({ type: "auth", roomId, userId: user.userId, token: user.token })
      )
    );
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_ok") {
        clearTimeout(timer);
        resolve({ ws, sessionId: msg.sessionId, receivedInput });
      }
      if (msg.type === "input") receivedInput.push(msg.content);
    });
    ws.on("error", reject);
  });
}

/** Simulated browser control connection. */
function openWebSocketAs(roomId, user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timer = setTimeout(() => reject(new Error("web auth_ok timeout")), 5000);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "auth",
          role: "web",
          roomId,
          userId: user.userId,
          token: user.token,
        })
      )
    );
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_ok") {
        clearTimeout(timer);
        resolve(ws);
      }
    });
    ws.on("error", reject);
  });
}

const sendInput = (ws, sessionId, content) =>
  ws.send(JSON.stringify({ type: "session_input", sessionId, content }));

async function liveControl(roomId, sessionId) {
  const lb = new Liveblocks({ secret: LIVEBLOCKS_SECRET_KEY });
  const doc = await lb.getStorageDocument(`tandem-room-${roomId}`, "json");
  const s = doc?.sessions?.[sessionId];
  return {
    controllerId: s?.controllerId ?? null,
    pendingRequesterId: s?.pendingRequesterId ?? null,
  };
}

// ─── setup ───────────────────────────────────────────────────────────────────

const a = await signIn(USER_A);
const b = await signIn(USER_B);
const c = await signIn(USER_C);

const inviteCode = "CT" + Math.random().toString(36).slice(2, 8).toUpperCase();
const { data: roomId, error: roomErr } = await asUser(a.token).rpc("create_room", {
  p_name: "e2e-control-room",
  p_invite_code: inviteCode,
});
if (roomErr) fatal(`create_room failed: ${roomErr.message}`);
for (const u of [b, c]) {
  const { error } = await asUser(u.token).rpc("join_room_by_invite_code", {
    p_invite_code: inviteCode,
  });
  if (error) fatal(`join failed: ${error.message}`);
}
console.log(`room: ${roomId}`);

// Owner A's "CLI" session.
const cli = await openCliSession(roomId, a);
console.log(`session: ${cli.sessionId}`);
const CONTROL = (action) => `/sessions/${cli.sessionId}/control/${action}`;

// ─── request rules ───────────────────────────────────────────────────────────

const ownerReq = await api(CONTROL("request"), a.token);
check("owner cannot request control of their own session (400)", ownerReq.status === 400);

const noToken = await api(CONTROL("request"), null);
check("request without token → 401", noToken.status === 401);

const bReq = await api(CONTROL("request"), b.token);
check("member can request control", bReq.status === 200, JSON.stringify(bReq.json));

const cReqWhilePending = await api(CONTROL("request"), c.token);
check("second request while pending → 409", cReqWhilePending.status === 409);

let mirror = await liveControl(roomId, cli.sessionId);
check("pending request mirrored to Liveblocks", mirror.pendingRequesterId === b.userId);

// ─── approve/deny authority ──────────────────────────────────────────────────

const bApprove = await api(CONTROL("approve"), b.token);
check("requester cannot approve their own request (403)", bApprove.status === 403);

const cDeny = await api(CONTROL("deny"), c.token);
check("non-owner cannot deny (403)", cDeny.status === 403);

const aDeny = await api(CONTROL("deny"), a.token);
check("owner can deny", aDeny.status === 200);
mirror = await liveControl(roomId, cli.sessionId);
check("deny clears mirror", mirror.pendingRequesterId === null && mirror.controllerId === null);

// ─── timeout ─────────────────────────────────────────────────────────────────

await api(CONTROL("request"), b.token);
await sleep(TIMEOUT_MS + 1500);
mirror = await liveControl(roomId, cli.sessionId);
check(
  `unanswered request expires after ~${TIMEOUT_MS}ms`,
  mirror.pendingRequesterId === null && mirror.controllerId === null,
  JSON.stringify(mirror)
);

// ─── grant + THE security-critical input path ────────────────────────────────

await api(CONTROL("request"), b.token);
const aApprove = await api(CONTROL("approve"), a.token);
check("owner can approve", aApprove.status === 200);
mirror = await liveControl(roomId, cli.sessionId);
check("grant mirrored to Liveblocks", mirror.controllerId === b.userId);

const bWeb = await openWebSocketAs(roomId, b);
const cWeb = await openWebSocketAs(roomId, c);

// Controller input must arrive.
sendInput(bWeb, cli.sessionId, "echo from-controller\r");
await sleep(600);
check(
  "controller's input reaches the CLI",
  cli.receivedInput.includes("echo from-controller\r"),
  `cli received: ${JSON.stringify(cli.receivedInput)}`
);

// NON-controller input must be silently dropped — the core security check.
const before = cli.receivedInput.length;
sendInput(cWeb, cli.sessionId, "rm -rf / #attack\r");
await sleep(600);
check(
  "SECURITY: non-controller session_input never reaches the CLI",
  cli.receivedInput.length === before &&
    !cli.receivedInput.includes("rm -rf / #attack\r"),
  `cli received: ${JSON.stringify(cli.receivedInput)}`
);

// Even the OWNER's web input is dropped while B controls (owner uses stdin).
const aWeb = await openWebSocketAs(roomId, a);
const before2 = cli.receivedInput.length;
sendInput(aWeb, cli.sessionId, "owner-web-input\r");
await sleep(600);
check(
  "SECURITY: even the owner's web input is dropped while another user controls",
  cli.receivedInput.length === before2
);

// ─── release semantics ───────────────────────────────────────────────────────

const cRelease = await api(CONTROL("release"), c.token);
check("bystander cannot release (403)", cRelease.status === 403);

const bRelease = await api(CONTROL("release"), b.token);
check("controller can release their own control", bRelease.status === 200);
mirror = await liveControl(roomId, cli.sessionId);
check("release clears mirror", mirror.controllerId === null);

const before3 = cli.receivedInput.length;
sendInput(bWeb, cli.sessionId, "after-release\r");
await sleep(600);
check(
  "SECURITY: former controller's input is dropped after release",
  cli.receivedInput.length === before3
);

// Owner revoke: re-grant to B, owner releases.
await api(CONTROL("request"), b.token);
await api(CONTROL("approve"), a.token);
const aRevoke = await api(CONTROL("release"), a.token);
check("owner can revoke at any time", aRevoke.status === 200);
mirror = await liveControl(roomId, cli.sessionId);
check("revoke clears mirror", mirror.controllerId === null);

// ─── auto-release on controller browser disconnect ───────────────────────────

await api(CONTROL("request"), b.token);
await api(CONTROL("approve"), a.token);
bWeb.close();
await sleep(1200);
mirror = await liveControl(roomId, cli.sessionId);
check(
  "control auto-releases when controller's browser disconnects",
  mirror.controllerId === null,
  JSON.stringify(mirror)
);

// ─── session end clears control ──────────────────────────────────────────────

const bWeb2 = await openWebSocketAs(roomId, b);
await api(CONTROL("request"), b.token);
await api(CONTROL("approve"), a.token);
cli.ws.close(1000);
await sleep(1500);
mirror = await liveControl(roomId, cli.sessionId);
check("control clears when the session's CLI disconnects", mirror.controllerId === null);

const postEnd = await api(CONTROL("request"), c.token);
check("cannot request control of a session with no live connection", postEnd.status === 409);

aWeb.close();
bWeb2.close();
cWeb.close();

// ─── cleanup ─────────────────────────────────────────────────────────────────

await admin.from("session_events").delete().eq("session_id", cli.sessionId);
await admin.from("rooms").delete().eq("id", roomId);
console.log("\ncleanup: removed test room and session");

summarize();
process.exit(failed === 0 ? 0 : 1);
