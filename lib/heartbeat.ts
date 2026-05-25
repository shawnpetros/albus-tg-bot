// Liveness signal: the bot writes a timestamp file every time it makes a
// successful poll round-trip. An external watchdog (launchd job) reads
// this file's mtime and force-restarts the bot if it's stale (older than
// HEARTBEAT_STALE_SECS). Catches "process alive but polling deadlocked"
// failures that launchd's own KeepAlive cannot detect.

import { writeFileSync } from "node:fs";

// File contains the ISO timestamp as plain text (one line). The mtime is
// what the watchdog uses; the body is for human debugging via `cat`.
export function writeHeartbeat(file: string): void {
  try {
    writeFileSync(file, `${new Date().toISOString()}\n`);
  } catch (e) {
    // Heartbeat write failures should not crash the bot; if disk fills up
    // or perms break, we'd rather keep polling and let the watchdog stale
    // us out than abort the loop ourselves.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("heartbeat write failed:", msg);
  }
}
