// Stage 6 e2e: project memory endpoints + RLS.
//   - member pins an entry; another member sees it; non-members are rejected
//   - only the pinning user can delete (API 403 + RLS no-op for others)
//   - RLS direct-access checks (member SELECT ok, spoofed INSERT rejected)
//
// Prerequisite: tandem-server must already be running. Run:
//   node test/e2e-stage6-memory.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "..", ".env") });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY } = process.env;
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

const inviteCode = "M6" + Math.random().toString(36).slice(2, 8).toUpperCase();
const { data: roomId, error: roomErr } = await asUser(a.token).rpc("create_room", {
  p_name: "e2e-memory-room",
  p_invite_code: inviteCode,
});
if (roomErr) fatal(`create_room failed: ${roomErr.message}`);
console.log(`room: ${roomId}`);

const MEM = `/rooms/${roomId}/memory`;

// ─── auth rules ──────────────────────────────────────────────────────────────

const noToken = await api("GET", MEM, null);
check("GET without token → 401", noToken.status === 401);

const nonMemberGet = await api("GET", MEM, b.token);
check("GET by non-member → 403", nonMemberGet.status === 403, `got ${nonMemberGet.status}`);

const nonMemberPost = await api("POST", MEM, b.token, { content: "x", tags: [] });
check("POST by non-member → 403", nonMemberPost.status === 403, `got ${nonMemberPost.status}`);

// ─── pin / list / delete flow ────────────────────────────────────────────────

const pinned = await api("POST", MEM, a.token, {
  content: "We use pnpm, never npm, for installs.",
  tags: ["tooling", "convention"],
});
check(
  "member can pin an entry",
  pinned.status === 200 && typeof pinned.json.entry?.id === "string",
  `got ${pinned.status}: ${JSON.stringify(pinned.json)}`
);
const entryId = pinned.json.entry?.id;

const emptyContent = await api("POST", MEM, a.token, { content: "   ", tags: [] });
check("empty content rejected → 400", emptyContent.status === 400);

// B joins, then sees A's entry.
const { error: joinErr } = await asUser(b.token).rpc("join_room_by_invite_code", {
  p_invite_code: inviteCode,
});
if (joinErr) fatal(`join failed: ${joinErr.message}`);

const listAsB = await api("GET", MEM, b.token);
check(
  "teammate sees the pinned entry (content + tags + pinned_by)",
  listAsB.status === 200 &&
    listAsB.json.entries?.length === 1 &&
    listAsB.json.entries[0].content.includes("pnpm") &&
    JSON.stringify(listAsB.json.entries[0].tags) === JSON.stringify(["tooling", "convention"]) &&
    listAsB.json.entries[0].pinned_by === a.userId,
  JSON.stringify(listAsB.json).slice(0, 200)
);

// B pins their own entry too (any member can create).
const pinnedB = await api("POST", MEM, b.token, { content: "API lives in /src/api", tags: [] });
check(
  "second member can pin; entry owned by them",
  pinnedB.status === 200 && pinnedB.json.entry?.pinned_by === b.userId
);

// Delete rules.
const deleteOthers = await api("DELETE", `${MEM}/${entryId}`, b.token);
check(
  "deleting someone else's entry → 403",
  deleteOthers.status === 403,
  `got ${deleteOthers.status}`
);

const deleteOwn = await api("DELETE", `${MEM}/${entryId}`, a.token);
check("deleting own entry → 200", deleteOwn.status === 200);

const afterDelete = await api("GET", MEM, a.token);
check(
  "deleted entry is gone; other entry remains",
  afterDelete.json.entries?.length === 1 &&
    afterDelete.json.entries[0].pinned_by === b.userId
);

// ─── RLS defense in depth (direct Supabase access, no tandem-server) ─────────

const { data: directRead, error: directReadErr } = await asUser(a.token)
  .from("memory_entries")
  .select("id")
  .eq("room_id", roomId);
check(
  "RLS: member can SELECT directly",
  !directReadErr && directRead?.length === 1,
  directReadErr?.message
);

const { error: spoofErr } = await asUser(a.token).from("memory_entries").insert({
  room_id: roomId,
  content: "spoofed",
  tags: [],
  pinned_by: b.userId, // claiming someone else pinned it
});
check("RLS: INSERT with spoofed pinned_by rejected", !!spoofErr, "insert succeeded?!");

// RLS DELETE of someone else's row: silently deletes 0 rows.
const { count: delCount } = await asUser(a.token)
  .from("memory_entries")
  .delete({ count: "exact" })
  .eq("pinned_by", b.userId);
check("RLS: DELETE of another user's rows affects 0 rows", (delCount ?? 0) === 0);

// ─── cleanup ─────────────────────────────────────────────────────────────────

await admin.from("rooms").delete().eq("id", roomId); // cascades memory_entries
console.log("\ncleanup: removed test room (memory entries cascade)");

summarize();
process.exit(failed === 0 ? 0 : 1);
