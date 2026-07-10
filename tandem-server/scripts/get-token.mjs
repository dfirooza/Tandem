// Prints a fresh Supabase access token for a user, for use as
// TANDEM_USER_TOKEN when running tandem-cli.
//
// Usage: node scripts/get-token.mjs <email> <password>
//
// Only the token is written to stdout, so it can be captured directly, e.g.:
//   TANDEM_USER_TOKEN=$(node scripts/get-token.mjs you@example.com yourpass)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "..", ".env") });

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    "Missing SUPABASE_URL / SUPABASE_ANON_KEY in tandem-server/.env"
  );
  process.exit(1);
}

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: node scripts/get-token.mjs <email> <password>");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await supabase.auth.signInWithPassword({
  email,
  password,
});
if (error) {
  console.error(`Sign-in failed: ${error.message}`);
  process.exit(1);
}

const { access_token, expires_at } = data.session;
console.error(
  `Token for ${email} (user ${data.user.id}), expires ` +
    new Date(expires_at * 1000).toISOString()
);
console.log(access_token);
