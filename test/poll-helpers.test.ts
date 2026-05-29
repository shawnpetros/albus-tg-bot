import { describe, expect, test } from "bun:test";
import { shouldCompact, looksLikeSessionLoss } from "../lib/poll.ts";
import {
  COMPACT_TOKEN_THRESHOLD,
  COMPACT_COOLDOWN_TURNS,
} from "../lib/config.ts";

const OVER = COMPACT_TOKEN_THRESHOLD + 50_000;

describe("shouldCompact (threshold)", () => {
  // No prior compaction (lastCompactTurn undefined): pure threshold gate.
  test("false below threshold", () => {
    expect(shouldCompact(COMPACT_TOKEN_THRESHOLD - 1, 1)).toBe(false);
  });
  test("true at threshold (>=)", () => {
    expect(shouldCompact(COMPACT_TOKEN_THRESHOLD, 1)).toBe(true);
  });
  test("true above threshold", () => {
    expect(shouldCompact(OVER, 1)).toBe(true);
  });
  test("false for zero/unknown usage", () => {
    expect(shouldCompact(0, 1)).toBe(false);
  });
});

describe("shouldCompact (cooldown backstop)", () => {
  // We compacted at turn 10. Even with context over threshold, we must not
  // re-compact until COMPACT_COOLDOWN_TURNS turns have elapsed.
  const lastCompactTurn = 10;

  test("false within cooldown even when context is over threshold", () => {
    // 1 turn after the compaction — well inside the window.
    expect(shouldCompact(OVER, lastCompactTurn + 1, lastCompactTurn)).toBe(false);
  });

  test("false at the last turn before cooldown elapses", () => {
    const justBefore = lastCompactTurn + COMPACT_COOLDOWN_TURNS - 1;
    expect(shouldCompact(OVER, justBefore, lastCompactTurn)).toBe(false);
  });

  test("true once cooldown has fully elapsed and context still over threshold", () => {
    const after = lastCompactTurn + COMPACT_COOLDOWN_TURNS;
    expect(shouldCompact(OVER, after, lastCompactTurn)).toBe(true);
  });

  test("cooldown does not rescue a below-threshold context", () => {
    const after = lastCompactTurn + COMPACT_COOLDOWN_TURNS;
    expect(shouldCompact(COMPACT_TOKEN_THRESHOLD - 1, after, lastCompactTurn)).toBe(false);
  });
});

describe("looksLikeSessionLoss", () => {
  test("matches classic session-resume failures", () => {
    expect(looksLikeSessionLoss("could not resume session")).toBe(true);
    expect(looksLikeSessionLoss("no such session id")).toBe(true);
    expect(looksLikeSessionLoss("failed reading foo.jsonl")).toBe(true);
  });
  test("matches exit-code failures (widened)", () => {
    expect(looksLikeSessionLoss("claude exited 1: boom")).toBe(true);
    expect(looksLikeSessionLoss("process exit 137")).toBe(true);
  });
  test("matches timeout failures (widened)", () => {
    expect(looksLikeSessionLoss("turn timed out after 600s")).toBe(true);
    expect(looksLikeSessionLoss("operation timeout")).toBe(true);
    expect(looksLikeSessionLoss("timed out")).toBe(true);
  });
  test("does not match unrelated errors", () => {
    expect(looksLikeSessionLoss("network unreachable")).toBe(false);
    expect(looksLikeSessionLoss("permission denied")).toBe(false);
    expect(looksLikeSessionLoss("")).toBe(false);
  });
});
