// Stage 13 Part A — status-bar terminal-control contract.
//
// Three layers:
//   1. Unit: the DECSTBM scroll-region and restore sequence builders are
//      exactly correct, and recompute for a new height (the resize value).
//   2. Exit paths: registerExitHandlers() runs the restore on all four paths
//      — normal exit, SIGINT, SIGTERM, and uncaughtException — driven through
//      the REAL handler code in a child process (deterministic, cross-platform;
//      no reliance on OS signal delivery through a PTY).
//   3. Integration: the actual `tandem` binary, run under a real PTY, emits
//      the DECSTBM region at startup, re-applies it on a resize, and restores
//      the full scroll region when the wrapped process exits.
//
// Run from tandem-cli/:  node test/statusbar.test.mjs   (build first)

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import * as pty from "node-pty";
import {
  STATUS_ROWS,
  scrollRegionSeq,
  barUpdateSeq,
  restoreSeq,
} from "../dist/statusbar.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Layer 1: sequence builders ──────────────────────────────────────────────

check("STATUS_ROWS is 4", STATUS_ROWS === 4);

// DECSTBM: top = STATUS_ROWS+1 = 5, bottom = terminal rows, wrapped in DEC
// save/restore so the cursor isn't homed.
check(
  "scrollRegionSeq(30) is exactly the DECSTBM contract",
  scrollRegionSeq(30) === "\x1b7\x1b[5;30r\x1b8",
  JSON.stringify(scrollRegionSeq(30))
);
check(
  "scrollRegionSeq recomputes for a resized height (40)",
  scrollRegionSeq(40) === "\x1b7\x1b[5;40r\x1b8" &&
    scrollRegionSeq(40) !== scrollRegionSeq(30),
  JSON.stringify(scrollRegionSeq(40))
);

const restore = restoreSeq(30);
check("restoreSeq resets scroll region to full screen (\\x1b[r)", restore.includes("\x1b[r"));
check(
  "restoreSeq clears all reserved rows",
  restore.includes("\x1b[1;1H\x1b[2K") &&
    restore.includes(`\x1b[${STATUS_ROWS};1H\x1b[2K`)
);
check("restoreSeq parks cursor at the bottom row (30)", restore.includes("\x1b[30;1H"));

// ─── Layer 2: exit paths through the real handler code ───────────────────────

// A child that imports registerExitHandlers, writes a sentinel + the restore
// sequence to a file when restore fires, then triggers one exit path.
const HARNESS = path.join(os.tmpdir(), `tandem-statusbar-harness-${process.pid}.mjs`);
fs.writeFileSync(
  HARNESS,
  `
import fs from "node:fs";
import { registerExitHandlers, restoreSeq } from ${JSON.stringify(
    pathToFileURL(path.join(__dirname, "..", "dist", "statusbar.js")).href
  )};
const out = process.argv[2];
const path_ = process.argv[3];
let restored = false;
registerExitHandlers(() => {
  if (restored) return;          // idempotency mirror of the real restore
  restored = true;
  fs.writeFileSync(out, "RESTORED" + restoreSeq(24));
});
if (path_ === "normal") {
  process.exit(0);
} else if (path_ === "sigint") {
  process.emit("SIGINT");
} else if (path_ === "sigterm") {
  process.emit("SIGTERM");
} else if (path_ === "uncaught") {
  setTimeout(() => { throw new Error("boom"); }, 5);
}
setTimeout(() => process.exit(99), 3000); // watchdog: handler never fired
`
);

function runExitPath(pathName, expectedCode) {
  return new Promise((resolve) => {
    const outFile = path.join(os.tmpdir(), `tandem-restore-${pathName}-${process.pid}.txt`);
    try { fs.rmSync(outFile); } catch {}
    const child = spawn(process.execPath, [HARNESS, outFile, pathName], { stdio: "ignore" });
    child.on("exit", (code) => {
      let content = "";
      try { content = fs.readFileSync(outFile, "utf8"); } catch {}
      resolve({ code, content });
      try { fs.rmSync(outFile); } catch {}
    });
  });
}

for (const [pathName, expectedCode] of [
  ["normal", 0],
  ["sigint", 130],
  ["sigterm", 143],
  ["uncaught", 1],
]) {
  const { code, content } = await runExitPath(pathName, expectedCode);
  check(
    `exit path '${pathName}': restore ran and reset scroll region`,
    content.startsWith("RESTORED") && content.includes("\x1b[r"),
    `content=${JSON.stringify(content.slice(0, 20))}`
  );
  check(
    `exit path '${pathName}': process exited with code ${expectedCode}`,
    code === expectedCode,
    `got ${code}`
  );
}
try { fs.rmSync(HARNESS); } catch {}

// ─── Layer 3: real PTY smoke test of the integrated binary ───────────────────
//
// The integrated binary runs under a REAL node-pty pseudo-terminal, wrapping a
// short-lived process. We drive the actual startup → resize → clean-exit
// lifecycle and confirm the status bar reaches each stage with the correct
// terminal dimensions.
//
// ⚠️ Windows ConPTY consumes DECSTBM/cursor escape sequences to update its own
// state — it does NOT echo the raw bytes back to a PTY reader (only printable
// text passes through). So we CANNOT grep node-pty output for `\x1b[5;30r`; it
// was already interpreted by the pseudo-console. Instead we observe the
// lifecycle via the CLI's TANDEM_STATUS_DEBUG markers (which report the exact
// rows/sequence used) — and Layer 1 above independently proves those sequences
// ARE the correct DECSTBM/restore bytes. Together: right bytes (Layer 1) +
// emitted at the right lifecycle points with the right dimensions (here).

// Fake but structurally valid JWT (userIdFromToken reads the `sub` claim).
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64url({ alg: "none" })}.${b64url({
  sub: "11111111-1111-1111-1111-111111111111",
})}.x`;

const ROWS = 30;
const NEW_ROWS = 40;

// Wrapped target: a script file (not inline `-e`, which cmd.exe mangles) that
// stays alive ~3.5s then exits 0 — long enough to observe startup + resize
// before the clean-exit restore.
const WRAPPED = path.join(os.tmpdir(), `tandem-wrapped-${process.pid}.mjs`);
fs.writeFileSync(WRAPPED, "setTimeout(() => process.exit(0), 3500);\n");

const term = pty.spawn(process.execPath, [CLI, process.execPath, WRAPPED], {
  name: "xterm-256color",
  cols: 80,
  rows: ROWS,
  cwd: process.cwd(),
  env: {
    ...process.env,
    TANDEM_STATUS_DEBUG: "1", // observation channel (see note above)
    TANDEM_SERVER_URL: "ws://127.0.0.1:59999", // unreachable → offline path
    TANDEM_ROOM_ID: "22222222-2222-2222-2222-222222222222",
    TANDEM_USER_TOKEN: FAKE_JWT,
  },
});

let output = "";
term.onData((d) => {
  output += d;
});

await sleep(1500); // let it start and reserve the region
check(
  "PTY: bar enabled with reduced rows at startup (rows=30)",
  /enabled=true isTTY=true rows=30/.test(output),
  output.match(/\[tandem-debug\][^\r\n]*/)?.[0]
);
check(
  "PTY: DECSTBM region set at startup with correct height",
  output.includes("region set rows=30"),
  "no 'region set rows=30' marker"
);

const beforeResize = output.length;
term.resize(80, NEW_ROWS);
await sleep(1500); // let the resize handler re-apply
const afterResize = output.slice(beforeResize);
check(
  "PTY: region re-applied on resize with new height (rows=40)",
  afterResize.includes("region set rows=40"),
  "no 'region set rows=40' marker after resize"
);

const exitCode = await new Promise((resolve) => term.onExit(({ exitCode }) => resolve(exitCode)));
check(
  "PTY: full scroll region restored on clean exit",
  output.includes("restore rows="),
  "no 'restore' marker seen on exit"
);
check("PTY: process exited (did not hang)", typeof exitCode === "number");
try { fs.rmSync(WRAPPED); } catch {}

// ─── Layer 4: the flicker bug — shared cursor register + the fix ─────────────
//
// Root cause: DECSC/DECRC (\x1b7/\x1b8) is a SINGLE shared register, not a
// stack. When the bar's draw injects its own save/restore between the wrapped
// app's save (one output chunk) and restore (a later chunk), the app's saved
// cursor is clobbered — its restore lands in the wrong place and its next
// write can paint over the reserved rows. Below: a minimal cursor-state
// machine proving the clobber, then assertions on the fixed draw sequence.

function makeTerm() {
  const cur = { r: 1, c: 1 };
  let saved = null; // single shared register
  return {
    cur,
    feed(s) {
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "\x1b" && s[i + 1] === "7") { saved = { ...cur }; i++; }
        else if (s[i] === "\x1b" && s[i + 1] === "8") { if (saved) { cur.r = saved.r; cur.c = saved.c; } i++; }
        else if (s[i] === "\x1b" && s[i + 1] === "[") {
          const m = s.slice(i).match(/^\x1b\[(\d+);(\d+)H/);
          if (m) { cur.r = +m[1]; cur.c = +m[2]; i += m[0].length - 1; }
        }
      }
    },
  };
}

// The clobber, demonstrated: app saves P, moves to Q, our naive save/restore
// injects, app restores → gets Q, not P. (This is the OLD drawStatusBar shape.)
{
  const t = makeTerm();
  t.feed("\x1b[20;5H\x1b7"); // app cursor P=(20,5), app SAVE
  t.feed("\x1b[22;9H"); // app draws, cursor now Q=(22,9)
  t.feed("\x1b7\x1b[1;1H\x1b[2K\x1b8"); // naive bar draw injects its own save/restore
  t.feed("\x1b8"); // app RESTORE (expects P)
  check(
    "hypothesis confirmed: naive save/restore clobbers the app's saved cursor",
    t.cur.r === 22 && t.cur.c === 9,
    `app cursor is (${t.cur.r},${t.cur.c}), expected the clobbered (22,9)`
  );
}

// The fix's structural properties.
const upd = barUpdateSeq(30, ["line-a", "line-b"]);
check("fix: bar update is wrapped in DEC synchronized output (begin+end)",
  upd.startsWith("\x1b[?2026h") && upd.endsWith("\x1b[?2026l"));
check("fix: bar update re-asserts the scroll region every draw",
  upd.includes("\x1b[5;30r"));
check("fix: bar update uses the shared register exactly once (one save, one restore)",
  (upd.match(/\x1b7/g) || []).length === 1 && (upd.match(/\x1b8/g) || []).length === 1);
check("fix: bar rows are written with absolute positioning (no cursor-relative moves)",
  upd.includes("\x1b[1;1H\x1b[2Kline-a") && upd.includes("\x1b[2;1H\x1b[2Kline-b"));
check("fix: bar update is a single contiguous string (atomic write, can't interleave)",
  typeof upd === "string" && !upd.includes("\n"));

// The heal behavior: whatever the wrapped app draws over the reserved rows,
// the bar is repainted promptly after output (throttled), not only on the
// slow 15s fetch. Verified end-to-end under a real PTY: after we push output
// that scribbles into the top rows, a fresh bar update appears within the
// throttle window (observed via the debug 'region set'... the barUpdateSeq
// path re-asserts region, so a repaint is observable as renewed activity).
{
  const WRAPPED2 = path.join(os.tmpdir(), `tandem-wrapped2-${process.pid}.mjs`);
  // Wrapped app that continuously emits output for ~2.5s (a streaming-response
  // stand-in), then exits — so the bar must survive/heal during the stream.
  fs.writeFileSync(
    WRAPPED2,
    `let n=0; const t=setInterval(()=>{process.stdout.write("stream line "+(++n)+"\\r\\n"); if(n>=25){clearInterval(t);process.exit(0);}}, 100);\n`
  );
  const term2 = pty.spawn(process.execPath, [CLI, process.execPath, WRAPPED2], {
    name: "xterm-256color", cols: 80, rows: 30, cwd: process.cwd(),
    env: {
      ...process.env,
      TANDEM_STATUS_DEBUG: "1",
      TANDEM_SERVER_URL: "ws://127.0.0.1:59999",
      TANDEM_ROOM_ID: "22222222-2222-2222-2222-222222222222",
      TANDEM_USER_TOKEN: FAKE_JWT,
    },
  });
  let out2 = "";
  term2.onData((d) => { out2 += d; });
  await sleep(1500); // mid-stream
  // During the stream the app is constantly emitting; scheduleDraw() must be
  // repainting the bar repeatedly (each 'bar draw' re-asserts the region and
  // rewrites the rows), rather than the single startup draw the old code did.
  const drawsDuringStream = (out2.match(/bar draw rows=30/g) || []).length;
  await new Promise((resolve) => term2.onExit(() => resolve()));
  check(
    "fix: bar is repainted repeatedly during a streaming response (heals, not one-shot)",
    drawsDuringStream >= 2,
    `only ${drawsDuringStream} bar draws seen during the stream`
  );
  try { fs.rmSync(WRAPPED2); } catch {}
}

// ─── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
