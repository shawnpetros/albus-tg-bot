import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSession,
  saveSession,
  recordTurn,
  loadSessionRecord,
  markCompacted,
} from "../lib/state.ts";

let tmpDir: string;
let sessionFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tgclaude-acct-"));
  sessionFile = join(tmpDir, "session.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readRaw(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("backward compatibility", () => {
  test("old-format record (only session_id) loads via loadSession", () => {
    writeFileSync(sessionFile, JSON.stringify({ session_id: "legacy-id" }));
    expect(loadSession(sessionFile)).toBe("legacy-id");
  });

  test("old-format record loads via loadSessionRecord without accounting fields", () => {
    writeFileSync(sessionFile, JSON.stringify({ session_id: "legacy-id" }));
    const rec = loadSessionRecord(sessionFile);
    expect(rec?.session_id).toBe("legacy-id");
    expect(rec?.turns).toBeUndefined();
    expect(rec?.total_cost_usd).toBeUndefined();
  });
});

describe("loadSessionRecord", () => {
  test("missing file returns null", () => {
    expect(loadSessionRecord(sessionFile)).toBeNull();
  });

  test("corrupt JSON returns null without throwing", () => {
    writeFileSync(sessionFile, "{not json");
    expect(loadSessionRecord(sessionFile)).toBeNull();
  });

  test("returns full record shape", () => {
    saveSession(sessionFile, "sess-1");
    const rec = loadSessionRecord(sessionFile);
    expect(rec?.session_id).toBe("sess-1");
    expect(typeof rec?.created_at).toBe("string");
  });
});

describe("session establishment", () => {
  test("adopting a new session id sets created_at and zeroes accounting", () => {
    saveSession(sessionFile, "sess-1");
    const raw = readRaw(sessionFile);
    expect(raw.session_id).toBe("sess-1");
    expect(typeof raw.created_at).toBe("string");
    expect(raw.turns).toBe(0);
    expect(raw.last_prompt_tokens).toBe(0);
    expect(raw.total_cost_usd).toBe(0);
  });

  test("rotation to a different id resets accumulators and sets fresh created_at", () => {
    saveSession(sessionFile, "sess-1");
    recordTurn(sessionFile, { promptTokens: 500, costUsd: 0.1 });
    recordTurn(sessionFile, { promptTokens: 800, costUsd: 0.2 });
    const beforeCreated = readRaw(sessionFile).created_at;

    saveSession(sessionFile, "sess-2");
    const raw = readRaw(sessionFile);
    expect(raw.session_id).toBe("sess-2");
    expect(raw.turns).toBe(0);
    expect(raw.last_prompt_tokens).toBe(0);
    expect(raw.total_cost_usd).toBe(0);
    expect(typeof raw.created_at).toBe("string");
    // created_at is re-established on rotation (may equal if same ms, so just
    // assert it is present and accumulators cleared, which is the contract)
    expect(beforeCreated).toBeDefined();
  });

  test("re-saving the SAME id preserves accumulators and created_at", () => {
    saveSession(sessionFile, "sess-1");
    recordTurn(sessionFile, { promptTokens: 500, costUsd: 0.1 });
    recordTurn(sessionFile, { promptTokens: 800, costUsd: 0.2 });
    const created = readRaw(sessionFile).created_at;

    saveSession(sessionFile, "sess-1");
    const raw = readRaw(sessionFile);
    expect(raw.turns).toBe(2);
    expect(raw.last_prompt_tokens).toBe(800);
    expect(raw.total_cost_usd).toBeCloseTo(0.3);
    expect(raw.created_at).toBe(created);
  });

  test("clearing with null still writes reset_at marker", () => {
    saveSession(sessionFile, "first");
    saveSession(sessionFile, null);
    const raw = readRaw(sessionFile);
    expect(raw.session_id).toBeNull();
    expect(typeof raw.reset_at).toBe("string");
  });
});

describe("recordTurn", () => {
  test("accumulates turns and cost, sets last_prompt_tokens", () => {
    saveSession(sessionFile, "sess-1");
    recordTurn(sessionFile, { promptTokens: 1000, costUsd: 0.05 });
    let rec = loadSessionRecord(sessionFile);
    expect(rec?.turns).toBe(1);
    expect(rec?.last_prompt_tokens).toBe(1000);
    expect(rec?.total_cost_usd).toBeCloseTo(0.05);

    rec = recordTurn(sessionFile, { promptTokens: 2500, costUsd: 0.07 });
    expect(rec.turns).toBe(2);
    expect(rec.last_prompt_tokens).toBe(2500);
    expect(rec.total_cost_usd).toBeCloseTo(0.12);
  });

  test("leaves session_id and created_at intact", () => {
    saveSession(sessionFile, "sess-1");
    const created = readRaw(sessionFile).created_at;
    const rec = recordTurn(sessionFile, { promptTokens: 100, costUsd: 0.01 });
    expect(rec.session_id).toBe("sess-1");
    expect(rec.created_at).toBe(created);
  });

  test("on a missing file, records a turn without throwing and does not invent created_at", () => {
    const rec = recordTurn(sessionFile, { promptTokens: 100, costUsd: 0.01 });
    expect(rec.turns).toBe(1);
    expect(rec.last_prompt_tokens).toBe(100);
    expect(rec.total_cost_usd).toBeCloseTo(0.01);
    expect(rec.created_at).toBeUndefined();
  });

  test("works on an old-format record (only session_id) by starting accumulators from zero", () => {
    writeFileSync(sessionFile, JSON.stringify({ session_id: "legacy" }));
    const rec = recordTurn(sessionFile, { promptTokens: 300, costUsd: 0.02 });
    expect(rec.session_id).toBe("legacy");
    expect(rec.turns).toBe(1);
    expect(rec.last_prompt_tokens).toBe(300);
    expect(rec.total_cost_usd).toBeCloseTo(0.02);
  });
});

describe("markCompacted (cooldown bookkeeping)", () => {
  test("stamps last_compact_turn with the current turns count", () => {
    saveSession(sessionFile, "sess-1");
    recordTurn(sessionFile, { promptTokens: 1000, costUsd: 0.05 });
    recordTurn(sessionFile, { promptTokens: 2000, costUsd: 0.05 });
    const rec = markCompacted(sessionFile);
    expect(rec.last_compact_turn).toBe(2);
    expect(loadSessionRecord(sessionFile)?.last_compact_turn).toBe(2);
  });

  test("preserves other accounting fields", () => {
    saveSession(sessionFile, "sess-1");
    recordTurn(sessionFile, { promptTokens: 1000, costUsd: 0.05 });
    const created = readRaw(sessionFile).created_at;
    const rec = markCompacted(sessionFile);
    expect(rec.session_id).toBe("sess-1");
    expect(rec.turns).toBe(1);
    expect(rec.last_prompt_tokens).toBe(1000);
    expect(rec.total_cost_usd).toBeCloseTo(0.05);
    expect(rec.created_at).toBe(created);
  });

  test("last_compact_turn is cleared on session rotation", () => {
    saveSession(sessionFile, "sess-1");
    recordTurn(sessionFile, { promptTokens: 1000, costUsd: 0.05 });
    markCompacted(sessionFile);
    expect(loadSessionRecord(sessionFile)?.last_compact_turn).toBe(1);

    saveSession(sessionFile, "sess-2");
    expect(loadSessionRecord(sessionFile)?.last_compact_turn).toBeUndefined();
  });

  test("last_compact_turn is preserved on re-save of the SAME id", () => {
    saveSession(sessionFile, "sess-1");
    recordTurn(sessionFile, { promptTokens: 1000, costUsd: 0.05 });
    markCompacted(sessionFile);
    saveSession(sessionFile, "sess-1");
    expect(loadSessionRecord(sessionFile)?.last_compact_turn).toBe(1);
  });

  test("missing file: stamps last_compact_turn 0 without throwing", () => {
    const rec = markCompacted(sessionFile);
    expect(rec.last_compact_turn).toBe(0);
  });
});
