// Terminal-control primitives for the Stage 13 status bar, extracted so the
// escape-sequence contract and exit-restore wiring are unit-testable in
// isolation (index.ts runs the whole CLI on import, so it can't be imported
// from a test). These functions are pure string builders plus one handler
// registrar — no I/O of their own.

/** Reserved rows at the top of the terminal. Fixed (not dynamic) so the
    wrapped PTY size — and thus Claude Code's layout — never churns. */
export const STATUS_ROWS = 4;

/**
 * DECSTBM scroll region confining scrolling to the area BELOW the reserved
 * rows: `\x1b[<top>;<bottom>r` with top = STATUS_ROWS+1. Wrapped in DEC
 * save/restore (\x1b7/\x1b8) because DECSTBM homes the cursor as a side
 * effect and we must not move the app's cursor.
 */
export function scrollRegionSeq(rows: number): string {
  return `\x1b7\x1b[${STATUS_ROWS + 1};${rows}r\x1b8`;
}

/**
 * One atomic status-bar update. Emitted as a SINGLE write so it can't be
 * split by forwarded PTY output. Structure, in order:
 *   - `\x1b[?2026h` — begin DEC synchronized output (terminals that support it
 *     present the whole update atomically; unsupported terminals ignore it),
 *     so a half-drawn bar is never shown.
 *   - `\x1b7` — save the wrapped app's current cursor (used exactly ONCE here).
 *   - re-assert the DECSTBM scroll region every update, so if the wrapped app
 *     ever reset the margins the reserved rows become protected again (the
 *     bar self-heals instead of being scrollable-over).
 *   - absolute-positioned writes into the reserved rows (no reliance on the
 *     cursor being anywhere in particular).
 *   - `\x1b8` — restore the app's cursor.
 *   - `\x1b[?2026l` — end synchronized output.
 *
 * The shared DECSC/DECRC register is still touched (there is no cursor
 * save/restore that ISN'T shared in a passthrough wrapper), but only once,
 * atomically, and — combined with prompt redraws on output (see index.ts) —
 * the bar heals in milliseconds rather than staying corrupted until the next
 * slow refresh.
 */
export function barUpdateSeq(rows: number, lines: string[]): string {
  let out = "\x1b[?2026h"; // begin synchronized update
  out += "\x1b7"; // save app cursor
  out += `\x1b[${STATUS_ROWS + 1};${rows}r`; // re-assert scroll region
  for (let i = 0; i < STATUS_ROWS; i++) {
    out += `\x1b[${i + 1};1H\x1b[2K` + (lines[i] ?? "");
  }
  out += "\x1b8"; // restore app cursor
  out += "\x1b[?2026l"; // end synchronized update
  return out;
}

/**
 * Full restore: reset the scroll region to the whole screen (`\x1b[r`), clear
 * the reserved rows, and park the cursor at the bottom. This is what must run
 * on every exit path so the terminal is left completely clean.
 */
export function restoreSeq(rows: number): string {
  let out = "\x1b[r"; // reset scroll region to full screen
  for (let i = 0; i < STATUS_ROWS; i++) {
    out += `\x1b[${i + 1};1H\x1b[2K`; // clear each reserved row
  }
  out += `\x1b[${rows};1H`; // park cursor at the bottom
  return out;
}

/**
 * Registers `restore` on every process exit path — normal exit, SIGINT
 * (Ctrl+C), SIGTERM, SIGHUP, and uncaughtException — so terminal state is
 * always cleaned up before the process is gone. `restore` must be idempotent
 * (it's called from multiple paths and the plain `exit` event as a backstop).
 */
export function registerExitHandlers(
  restore: () => void,
  onFatal?: (err: unknown) => void
): void {
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restore();
    process.exit(143);
  });
  process.on("SIGHUP", () => {
    restore();
    process.exit(129);
  });
  process.on("uncaughtException", (err) => {
    restore();
    onFatal?.(err);
    process.exit(1);
  });
}
