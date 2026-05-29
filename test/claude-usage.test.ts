import { describe, expect, test } from "bun:test";
import { extractUsage } from "../lib/claude.ts";

describe("extractUsage", () => {
  test("contextTokens = last assistant usage; costUsd = cumulative result cost", () => {
    // Assistant-message usage blocks captured during the stream (one per
    // internal model call in the agentic turn). Each is a single round-trip's
    // resident view of the thread.
    const assistantUsages = [
      { input_tokens: 1000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 5000 },
      { input_tokens: 1200, cache_read_input_tokens: 48000, cache_creation_input_tokens: 6000 },
      { input_tokens: 1500, cache_read_input_tokens: 50000, cache_creation_input_tokens: 7000 },
    ];
    const resultEvent = {
      type: "result",
      total_cost_usd: 0.227,
      // The result `usage` is CUMULATIVE and huge — must NOT feed contextTokens.
      usage: {
        input_tokens: 900000,
        cache_read_input_tokens: 600000,
        cache_creation_input_tokens: 100000,
      },
    };
    const u = extractUsage(assistantUsages, resultEvent);
    // Last message: 1500 + 50000 + 7000 = 58500. NOT the sum, NOT the result.
    expect(u.contextTokens).toBe(58500);
    expect(u.costUsd).toBeCloseTo(0.227, 6);
  });

  test("REGRESSION: many ~50-59k messages whose SUM is millions -> returns last ~59k, not the sum", () => {
    // Reproduces the production bug: an agentic turn makes dozens of model
    // calls. Each individual context is ~50-59k. Their sum is millions and
    // exceeds the 1M window — an impossible context size. contextTokens must
    // be the LAST single-message value, not the accumulation.
    const assistantUsages = [];
    let runningSum = 0;
    for (let i = 0; i < 30; i++) {
      const input = 1000;
      const cacheRead = 52000 + i * 200; // climbs from ~53k to ~59k
      const block = {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0,
      };
      runningSum += input + cacheRead;
      assistantUsages.push(block);
    }
    const last = assistantUsages[assistantUsages.length - 1]!;
    const lastContext =
      last.input_tokens +
      last.cache_read_input_tokens +
      last.cache_creation_input_tokens;

    const u = extractUsage(assistantUsages, { type: "result", total_cost_usd: 1.5 });

    expect(runningSum).toBeGreaterThan(1_000_000); // sum is impossible as a context size
    expect(lastContext).toBeLessThan(60_000); // true fill is small
    expect(u.contextTokens).toBe(lastContext);
    expect(u.contextTokens).toBeLessThan(60_000);
  });

  test("no assistant usage blocks -> contextTokens 0 (defensive, no throw)", () => {
    const u = extractUsage([], { type: "result", total_cost_usd: 0.01 });
    expect(u.contextTokens).toBe(0);
    expect(u.costUsd).toBeCloseTo(0.01, 6);
  });

  test("missing usage sub-fields treated as 0", () => {
    const u = extractUsage([{ input_tokens: 100 }], { type: "result" });
    expect(u.contextTokens).toBe(100);
    expect(u.costUsd).toBe(0);
  });

  test("result with no usage/cost yields cost 0, no throw", () => {
    const u = extractUsage([{ cache_read_input_tokens: 5000 }], {
      type: "result",
      is_error: true,
    });
    expect(u.contextTokens).toBe(5000);
    expect(u.costUsd).toBe(0);
  });

  test("no total_cost_usd: sums modelUsage costUSD", () => {
    const u = extractUsage([{ input_tokens: 42 }], {
      type: "result",
      modelUsage: {
        "model-a": { costUSD: 0.1 },
        "model-b": { costUSD: 0.2 },
      },
    });
    expect(u.costUsd).toBeCloseTo(0.3, 6);
  });

  test("null/undefined inputs are tolerated", () => {
    const u = extractUsage(undefined as any, null as any);
    expect(u.contextTokens).toBe(0);
    expect(u.costUsd).toBe(0);
  });
});
