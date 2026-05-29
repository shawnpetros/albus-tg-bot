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
  // The `turns` value at the last compaction. Drives the compaction cooldown
  // in poll.ts (no re-compact until COMPACT_COOLDOWN_TURNS have elapsed since
  // this point). Reset on session rotation alongside the other accumulators.
  last_compact_turn?: number;
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
        // Preserve the cooldown marker across re-saves of the same session;
        // it is only meaningful within one session's lifetime.
        last_compact_turn: prev?.last_compact_turn,
      }
    : {
        // Rotation/establishment: fresh session, no compaction yet, so
        // last_compact_turn is intentionally omitted (reset).
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
    last_compact_turn: prev?.last_compact_turn,
  };
  writeFileSync(file, JSON.stringify(record, null, 2));
  return record;
}

// Record that a compaction just ran by stamping last_compact_turn with the
// current turns count. The cooldown gate in poll.ts measures distance from
// this point. Preserves all other accounting; tolerant of missing/legacy
// files (stamps last_compact_turn = current turns, defaulting to 0).
export function markCompacted(file: string): SessionRecord {
  const prev = loadSessionRecord(file);
  const record: SessionRecord = {
    session_id: prev?.session_id ?? null,
    updated_at: new Date().toISOString(),
    reset_at: prev?.reset_at,
    created_at: prev?.created_at,
    turns: prev?.turns ?? 0,
    last_prompt_tokens: prev?.last_prompt_tokens ?? 0,
    total_cost_usd: prev?.total_cost_usd ?? 0,
    last_compact_turn: prev?.turns ?? 0,
  };
  writeFileSync(file, JSON.stringify(record, null, 2));
  return record;
}

// --- Per-day spend guardrail ---------------------------------------------

export interface DailyCostRecord {
  // Local calendar date this record accounts for, "YYYY-MM-DD".
  date: string;
  // Sum of turn costUsd accrued on `date`.
  cost_usd: number;
  // Whether the over-limit warning has already fired today (once-per-day).
  warned?: boolean;
}

// Local "YYYY-MM-DD" for a given Date. Pure; used so the rollover boundary is
// the operator's calendar day, not UTC.
export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Pure: fold a turn's cost into the daily record, rolling over when the date
// changes. On a new day the accumulator resets to just `add` and the warned
// flag clears. Within the same day, costs accumulate and warned is preserved.
// A null/undefined prior (first-ever, missing, or corrupt file) starts fresh.
export function rolloverDailyCost(
  prev: DailyCostRecord | null | undefined,
  date: string,
  add: number
): DailyCostRecord {
  if (!prev || prev.date !== date) {
    return { date, cost_usd: add, warned: false };
  }
  return { date, cost_usd: prev.cost_usd + add, warned: prev.warned ?? false };
}

// Pure predicate: has the day's spend reached/crossed the limit?
export function overDailyLimit(record: DailyCostRecord, limit: number): boolean {
  return record.cost_usd >= limit;
}

export function loadDailyCost(file: string): DailyCostRecord | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DailyCostRecord;
  } catch {
    return null;
  }
}

export function saveDailyCost(file: string, record: DailyCostRecord): void {
  writeFileSync(file, JSON.stringify(record, null, 2));
}

// Load, fold in this turn's cost (with date rollover), persist, return the new
// record. The single entry point poll.ts uses after a turn.
export function recordDailyCost(
  file: string,
  add: number,
  now: Date = new Date()
): DailyCostRecord {
  const prev = loadDailyCost(file);
  const next = rolloverDailyCost(prev, localDateStr(now), add);
  saveDailyCost(file, next);
  return next;
}

// Stamp warned=true so the over-limit warning fires only once per day.
export function markDailyWarned(file: string): DailyCostRecord {
  const prev = loadDailyCost(file);
  const record: DailyCostRecord = prev
    ? { ...prev, warned: true }
    : { date: localDateStr(), cost_usd: 0, warned: true };
  saveDailyCost(file, record);
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
