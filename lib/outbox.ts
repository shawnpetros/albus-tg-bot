// Per-turn outbox: Claude writes files into a turn-specific directory; the
// bot flushes them as Telegram attachments after the reply lands.
//
// Sender dependencies (sendAttachment, sendMessage) are injected so this
// module is unit-testable without hitting the Telegram API.

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";

export interface OutboxDeps {
  sendAttachment: (path: string, caption?: string) => Promise<unknown>;
  sendMessage: (text: string, opts?: { markdown?: boolean }) => Promise<void>;
}

export async function flushOutbox(turnDir: string, deps: OutboxDeps): Promise<number> {
  if (!existsSync(turnDir)) return 0;
  let sent = 0;
  for (const name of readdirSync(turnDir)) {
    // Hidden files and caption sidecars are not standalone deliveries.
    if (name.startsWith(".") || name.endsWith(".caption.txt")) continue;
    const full = `${turnDir}/${name}`;
    const captionPath = `${full}.caption.txt`;
    const caption = existsSync(captionPath)
      ? readFileSync(captionPath, "utf8").trim()
      : undefined;
    try {
      await deps.sendAttachment(full, caption);
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`outbox send failed for ${name}: ${msg}`);
      await deps.sendMessage(`couldn't send attachment ${name}: ${msg}`, { markdown: false });
    }
  }
  // Best-effort cleanup so a future turn with the same message_id doesn't
  // see stale files. If removal fails (file lock, permissions), the next
  // pass will still skip files older than this turn's flush.
  try {
    rmSync(turnDir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
  return sent;
}

// Sweep orphaned per-turn directories: ones the harness created (or the agent
// wrote into) for a different message_id that never got flushed, because the
// flush only ever targets the current turn's dir. Without this, a single
// path slip silently strands attachments forever and leaves the outbox to
// accumulate cruft.
//
// `parentDir`   the OUTBOX_DIR holding per-turn subdirs (and loose ack files).
// `currentDir`  this turn's dir, already flushed — skipped here.
// `minAgeMs`    only sweep dirs untouched for at least this long, so a turn
//               that's genuinely in flight (e.g. a future concurrent worker)
//               is never raided mid-write. Defaults to 2 minutes.
//
// Loose files (e.g. ack-<id>.ogg) are ignored — only directories are swept.
export async function sweepOrphanOutboxes(
  parentDir: string,
  currentDir: string,
  deps: OutboxDeps,
  minAgeMs = 2 * 60 * 1000,
  now = Date.now()
): Promise<number> {
  if (!existsSync(parentDir)) return 0;
  let sent = 0;
  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = `${parentDir}/${entry.name}`;
    if (dir === currentDir) continue;
    let mtimeMs;
    try {
      mtimeMs = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < minAgeMs) continue; // too fresh; could be in flight
    sent += await flushOutbox(dir, deps);
  }
  return sent;
}
