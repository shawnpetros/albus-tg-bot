import { describe, expect, test } from "bun:test";
import { shouldCompact, looksLikeSessionLoss } from "../lib/poll.ts";
import { COMPACT_TOKEN_THRESHOLD } from "../lib/config.ts";

describe("shouldCompact", () => {
  test("false below threshold", () => {
    expect(shouldCompact(COMPACT_TOKEN_THRESHOLD - 1)).toBe(false);
  });
  test("true at threshold (>=)", () => {
    expect(shouldCompact(COMPACT_TOKEN_THRESHOLD)).toBe(true);
  });
  test("true above threshold", () => {
    expect(shouldCompact(COMPACT_TOKEN_THRESHOLD + 50_000)).toBe(true);
  });
  test("false for zero/unknown usage", () => {
    expect(shouldCompact(0)).toBe(false);
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
