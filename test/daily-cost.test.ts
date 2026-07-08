import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rolloverDailyCost,
  overDailyLimit,
  recordDailyCost,
  markDailyWarned,
  loadDailyCost,
  localDateStr,
  type DailyCostRecord,
} from "../lib/state.ts";

describe("rolloverDailyCost (pure)", () => {
  test("null prior starts a fresh record", () => {
    const r = rolloverDailyCost(null, "2026-05-29", 1.5);
    expect(r).toEqual({ date: "2026-05-29", cost_usd: 1.5, warned: false });
  });

  test("same day accumulates and preserves warned", () => {
    const prev: DailyCostRecord = { date: "2026-05-29", cost_usd: 2, warned: true };
    const r = rolloverDailyCost(prev, "2026-05-29", 0.5);
    expect(r.cost_usd).toBeCloseTo(2.5);
    expect(r.warned).toBe(true);
  });

  test("date change resets accumulator and clears warned", () => {
    const prev: DailyCostRecord = { date: "2026-05-29", cost_usd: 19.9, warned: true };
    const r = rolloverDailyCost(prev, "2026-05-30", 0.3);
    expect(r).toEqual({ date: "2026-05-30", cost_usd: 0.3, warned: false });
  });
});

describe("overDailyLimit (pure)", () => {
  const rec = (cost: number): DailyCostRecord => ({ date: "2026-05-29", cost_usd: cost });

  test("false below limit", () => {
    expect(overDailyLimit(rec(19.99), 20)).toBe(false);
  });
  test("true at limit (>=)", () => {
    expect(overDailyLimit(rec(20), 20)).toBe(true);
  });
  test("true above limit", () => {
    expect(overDailyLimit(rec(25), 20)).toBe(true);
  });
});

describe("daily-cost persistence", () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tgclaude-daily-"));
    file = join(tmpDir, "daily-cost.json");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("missing file loads as null", () => {
    expect(loadDailyCost(file)).toBeNull();
  });

  test("corrupt file loads as null without throwing", () => {
    require("node:fs").writeFileSync(file, "{not json");
    expect(loadDailyCost(file)).toBeNull();
  });

  test("recordDailyCost accumulates within a day", () => {
    const now = new Date("2026-05-29T10:00:00");
    recordDailyCost(file, 5, now);
    const r = recordDailyCost(file, 3, now);
    expect(r.date).toBe(localDateStr(now));
    expect(r.cost_usd).toBeCloseTo(8);
  });

  test("recordDailyCost resets when the date rolls over", () => {
    recordDailyCost(file, 18, new Date("2026-05-29T23:00:00"));
    const r = recordDailyCost(file, 2, new Date("2026-05-30T01:00:00"));
    expect(r.date).toBe("2026-05-30");
    expect(r.cost_usd).toBeCloseTo(2);
    expect(r.warned).toBe(false);
  });

  test("markDailyWarned flips warned once and persists", () => {
    recordDailyCost(file, 21, new Date("2026-05-29T10:00:00"));
    const before = loadDailyCost(file)!;
    expect(before.warned).toBe(false);
    markDailyWarned(file);
    const after = loadDailyCost(file)!;
    expect(after.warned).toBe(true);
    // Accumulator preserved by the warn stamp.
    expect(after.cost_usd).toBeCloseTo(21);
  });

  test("once-per-day warning: warned survives same-day re-record", () => {
    const now = new Date("2026-05-29T10:00:00");
    recordDailyCost(file, 21, now);
    markDailyWarned(file);
    const r = recordDailyCost(file, 1, now);
    // Same day: warned must NOT reset, so the warning fires only once.
    expect(r.warned).toBe(true);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.warned).toBe(true);
  });
});
