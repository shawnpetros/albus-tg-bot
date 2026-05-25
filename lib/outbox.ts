// Per-turn outbox: Claude writes files into a turn-specific directory; the
// bot flushes them as Telegram attachments after the reply lands.
//
// Sender dependencies (sendAttachment, sendMessage) are injected so this
// module is unit-testable without hitting the Telegram API.

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";

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
