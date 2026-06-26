import { describe, expect, test } from "bun:test";
import {
  formatTokens,
  formatCost,
  formatStatusLine,
} from "../lib/telemetry.ts";

describe("formatTokens", () => {
  test("sub-thousand stays raw", () => {
    expect(formatTokens(950)).toBe("950");
  });
  test("thousands round to k", () => {
    expect(formatTokens(58_000)).toBe("58k");
    expect(formatTokens(58_400)).toBe("58k");
    expect(formatTokens(58_600)).toBe("59k");
  });
  test("exact million is 1M, fractional gets one decimal", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
  test("zero / negative / non-finite floor to 0", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(NaN)).toBe("0");
  });
});

describe("formatCost", () => {
  test("under a dime shows 4 decimals", () => {
    expect(formatCost(0.0231)).toBe("0.0231");
    expect(formatCost(0)).toBe("0.0000");
  });
  test("at or above a dime shows 2 decimals", () => {
    expect(formatCost(0.1)).toBe("0.10");
    expect(formatCost(1.47)).toBe("1.47");
  });
});

describe("formatStatusLine: lock reminder always survives", () => {
  const base = {
    contextTokens: 58_000,
    contextWindow: 1_000_000,
    passCostUsd: 0.0231,
    sessionCostUsd: 0.84,
    dailyCostUsd: 1.47,
  };

  test("unlocked + metrics: full line ending in the lock reminder", () => {
    const line = formatStatusLine({ ...base, unlocked: true, showMetrics: true });
    expect(line).toBe(
      "🔓 58k/1M (6%) · $0.0231 pass · $0.84 sess · $1.47 day · /lock when done"
    );
  });

  test("unlocked + metrics OFF still shows the lock reminder", () => {
    const line = formatStatusLine({ ...base, unlocked: true, showMetrics: false });
    expect(line).toBe("🔓 still unlocked - /lock when done");
  });

  test("locked + metrics: telemetry only, no lock reminder", () => {
    const line = formatStatusLine({ ...base, unlocked: false, showMetrics: true });
    expect(line).toBe(
      "🔒 58k/1M (6%) · $0.0231 pass · $0.84 sess · $1.47 day"
    );
  });

  test("locked + metrics OFF: empty (preserves no-footer behavior)", () => {
    const line = formatStatusLine({ ...base, unlocked: false, showMetrics: false });
    expect(line).toBe("");
  });
});

describe("formatStatusLine: degraded inputs", () => {
  test("no window: drops the denominator and percent", () => {
    const line = formatStatusLine({
      unlocked: true,
      showMetrics: true,
      contextTokens: 58_000,
      contextWindow: null,
      passCostUsd: 0.0231,
      sessionCostUsd: 0.84,
      dailyCostUsd: 1.47,
    });
    expect(line).toBe(
      "🔓 58k ctx · $0.0231 pass · $0.84 sess · $1.47 day · /lock when done"
    );
  });

  test("zero context fill: omit the ctx segment, keep costs", () => {
    const line = formatStatusLine({
      unlocked: true,
      showMetrics: true,
      contextTokens: 0,
      contextWindow: 1_000_000,
      passCostUsd: 0.0231,
      sessionCostUsd: 0.84,
      dailyCostUsd: 1.47,
    });
    expect(line).toBe(
      "🔓 $0.0231 pass · $0.84 sess · $1.47 day · /lock when done"
    );
  });
});
