// Stage 9 e2e: team chat.
//   - member posts a message via POST /rooms/:id/chat; teammate reads it via
//     RLS; non-members and anonymous callers are rejected
//   - message mirrored into Liveblocks chatMessages list
//   - RLS: spoofed-sender INSERT rejected; no UPDATE/DELETE allowed
//
// Prerequisite: tandem-server must already be running. Run:
//   node test/e2e-stage9-chat.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Liveblocks } from "@liveblocks/node";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "..", ".env") });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, LIVEBLOCKS_SECRET_KEY } =
  process.env;
const PORT = Number(process.env.PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;

// Test-account credentials come from tandem-server/.env (see .env.example).
// Emails are identifiers and fall back to defaults; the password is real and
// is never hardcoded here.
const TEST_PASSWORD = process.env.TANDEM_TEST_PASSWORD;
if (!TEST_PASSWORD) {
  console.error("Missing TANDEM_TEST_PASSWORD in tandem-server/.env — see .env.example");
  process.exit(1);
}

const USER_A = {
  email: process.env.TANDEM_TEST_EMAIL_A ?? "test-e2e@tandem.dev",
  password: TEST_PASSWORD,
};
const USER_B = {
  email: process.env.TANDEM_TEST_EMAIL_B ?? "test-e2e-b@tandem.dev",
  password: TEST_PASSWORD,
};

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

async function signIn({ email, password }) {
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) fatal(`could not sign in ${email}: ${error.message}`);
  return { userId: data.user.id, token: data.session.access_token };
}

function asUser(token) {
  // Anon key + user JWT: exercises real RLS (no service role).
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY ?? SUPABASE_SERVICE_ROLE_KEY, {
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

// ─── setup ───────────────────────────────────────────────────────────────────

const a = await signIn(USER_A);
const b = await signIn(USER_B);

const inviteCode = "C9" + Math.random().toString(36).slice(2, 8).toUpperCase();
const { data: roomId, error: roomErr } = await asUser(a.token).rpc("create_room", {
  p_name: "e2e-chat-room",
  p_invite_code: inviteCode,
});
if (roomErr) fatal(`create_room failed: ${roomErr.message}`);
console.log(`room: ${roomId}`);

const CHAT = `/rooms/${roomId}/chat`;

// ─── auth rules ──────────────────────────────────────────────────────────────

const noToken = await api("POST", CHAT, null, { content: "hi" });
check("POST without token → 401", noToken.status === 401);

const nonMember = await api("POST", CHAT, b.token, { content: "hi" });
check("POST by non-member → 403", nonMember.status === 403, `got ${nonMember.status}`);

const empty = await api("POST", CHAT, a.token, { content: "   " });
check("empty content → 400", empty.status === 400);

// ─── send / read flow ────────────────────────────────────────────────────────

const sent = await api("POST", CHAT, a.token, { content: "hello team, shipping stage 9" });
check(
  "member can send a message",
  sent.status === 200 && typeof sent.json.message?.id === "string",
  `got ${sent.status}: ${JSON.stringify(sent.json)}`
);
const messageId = sent.json.message?.id;

// B joins, sends a reply, and reads history via RLS (the page-load path).
const { error: joinErr } = await asUser(b.token).rpc("join_room_by_invite_code", {
  p_invite_code: inviteCode,
});
if (joinErr) fatal(`join failed: ${joinErr.message}`);

const reply = await api("POST", CHAT, b.token, { content: "reply from B" });
check(
  "second member can send; message owned by them",
  reply.status === 200 && reply.json.message?.user_id === b.userId
);

const { data: historyAsB, error: readErr } = await asUser(b.token)
  .from("chat_messages")
  .select("id, user_id, content")
  .eq("room_id", roomId)
  .order("created_at", { ascending: true });
check(
  "teammate reads full history via RLS (durable page-load path)",
  !readErr &&
    historyAsB?.length === 2 &&
    historyAsB[0].id === messageId &&
    historyAsB[0].user_id === a.userId &&
    historyAsB[1].content === "reply from B",
  readErr?.message ?? JSON.stringify(historyAsB)
);

// ─── RLS defense in depth ────────────────────────────────────────────────────

const { error: spoofErr } = await asUser(b.token).from("chat_messages").insert({
  room_id: roomId,
  user_id: a.userId, // claiming someone else sent it
  content: "spoofed",
});
check("RLS: INSERT with spoofed user_id rejected", !!spoofErr, "insert succeeded?!");

const { error: updateErr } = await asUser(a.token)
  .from("chat_messages")
  .update({ content: "edited" })
  .eq("id", messageId);
const { data: afterUpdate } = await admin
  .from("chat_messages")
  .select("content")
  .eq("id", messageId)
  .single();
check(
  "RLS: messages cannot be edited (no UPDATE policy)",
  afterUpdate?.content === "hello team, shipping stage 9",
  updateErr?.message ?? `content is now "${afterUpdate?.content}"`
);

const { count: delCount } = await asUser(a.token)
  .from("chat_messages")
  .delete({ count: "exact" })
  .eq("id", messageId);
const { data: afterDelete } = await admin
  .from("chat_messages")
  .select("id")
  .eq("id", messageId)
  .maybeSingle();
check(
  "RLS: messages cannot be deleted (no DELETE policy)",
  (delCount ?? 0) === 0 && !!afterDelete
);

// ─── Liveblocks mirror ───────────────────────────────────────────────────────

if (LIVEBLOCKS_SECRET_KEY) {
  const lb = new Liveblocks({ secret: LIVEBLOCKS_SECRET_KEY });
  const doc = await lb.getStorageDocument(`tandem-room-${roomId}`, "json");
  const chat = doc?.chatMessages ?? [];
  check(
    "Liveblocks: both messages mirrored in order",
    chat.length === 2 &&
      chat[0].id === messageId &&
      chat[0].userId === a.userId &&
      chat[1].content === "reply from B",
    JSON.stringify(chat).slice(0, 200)
  );
} else {
  console.log("SKIP  Liveblocks assertion (no key)");
}

// ─── cleanup ─────────────────────────────────────────────────────────────────

await admin.from("rooms").delete().eq("id", roomId); // cascades chat_messages
console.log("\ncleanup: removed test room (chat messages cascade)");

summarize();
process.exit(failed === 0 ? 0 : 1);
