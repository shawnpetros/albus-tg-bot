// Persistence for the two bits of cross-turn state: the current Claude
// session id (so --resume threads conversation) and the bot's mode (locked
// vs unlocked tool surface). Both round-trip through JSON files in
// STATE_DIR. Reads are tolerant of missing/corrupt files; writes are
// best-effort sync writes (small files, no race-loss expected).

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface SessionRecord {
  session_id: string | null;
  updated_at?: string;
  reset_at?: string;
}

export interface BotState {
  unlocked: boolean;
  unlocked_at?: string;
}

export function loadSession(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as SessionRecord;
    return data.session_id || null;
  } catch {
    return null;
  }
}

export function saveSession(file: string, id: string | null): void {
  const payload: SessionRecord =
    id === null
      ? { session_id: null, reset_at: new Date().toISOString() }
      : { session_id: id, updated_at: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(payload, null, 2));
}

export function loadState(file: string): BotState {
  if (!existsSync(file)) return { unlocked: false };
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BotState;
  } catch {
    return { unlocked: false };
  }
}

export function saveState(file: string, state: BotState): void {
  writeFileSync(file, JSON.stringify(state, null, 2));
}
