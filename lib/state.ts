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
  // Per-session accounting. Established when a session id is first set and
  // reset on rotation; preserved across re-saves of the same id. Optional so
  // legacy files (only session_id) still parse.
  created_at?: string;
  turns?: number;
  last_prompt_tokens?: number;
  total_cost_usd?: number;
}

export interface BotState {
  unlocked: boolean;
  unlocked_at?: string;
  // Optional model override passed to `claude -p --model`. When absent, the
  // CLI default applies. Set/cleared via the /model slash command. Stored as
  // the resolved model id (e.g. "claude-opus-4-8"), not a friendly alias.
  model?: string;
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

// Read the full record (including accounting) for status display. Tolerant of
// missing/corrupt files like loadSession.
export function loadSessionRecord(file: string): SessionRecord | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionRecord;
  } catch {
    return null;
  }
}

export function saveSession(file: string, id: string | null): void {
  if (id === null) {
    const payload: SessionRecord = {
      session_id: null,
      reset_at: new Date().toISOString(),
    };
    writeFileSync(file, JSON.stringify(payload, null, 2));
    return;
  }

  // Establishment vs rotation vs re-save of the same id. When the id is
  // unchanged from what is on disk, preserve the accounting accumulators and
  // created_at. When it changes (or is first set), establish a fresh session:
  // set created_at and zero the accumulators.
  const prev = loadSessionRecord(file);
  const sameSession = prev?.session_id === id;

  const payload: SessionRecord = sameSession
    ? {
        session_id: id,
        updated_at: new Date().toISOString(),
        created_at: prev?.created_at,
        turns: prev?.turns ?? 0,
        last_prompt_tokens: prev?.last_prompt_tokens ?? 0,
        total_cost_usd: prev?.total_cost_usd ?? 0,
      }
    : {
        session_id: id,
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        turns: 0,
        last_prompt_tokens: 0,
        total_cost_usd: 0,
      };
  writeFileSync(file, JSON.stringify(payload, null, 2));
}

// Record a completed turn's usage against the current session. Increments
// turns, sets last_prompt_tokens to the latest context-size signal, and adds
// to cumulative cost. Leaves session_id and created_at untouched (created_at
// is set on session establishment, not here). Tolerant of missing/legacy
// files: starts accumulators from zero.
export function recordTurn(
  file: string,
  usage: { promptTokens: number; costUsd: number }
): SessionRecord {
  const prev = loadSessionRecord(file);
  const record: SessionRecord = {
    session_id: prev?.session_id ?? null,
    updated_at: new Date().toISOString(),
    reset_at: prev?.reset_at,
    created_at: prev?.created_at,
    turns: (prev?.turns ?? 0) + 1,
    last_prompt_tokens: usage.promptTokens,
    total_cost_usd: (prev?.total_cost_usd ?? 0) + usage.costUsd,
  };
  writeFileSync(file, JSON.stringify(record, null, 2));
  return record;
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
