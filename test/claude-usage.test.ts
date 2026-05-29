import { describe, expect, test } from "bun:test";
import { extractUsage } from "../lib/claude.ts";

describe("extractUsage", () => {
  test("full result event captures promptTokens, contextWindow, costUsd", () => {
    const evt = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sess-1",
      total_cost_usd: 0.227,
      num_turns: 1,
      usage: {
        input_tokens: 15681,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 23794,
        output_tokens: 4,
      },
      modelUsage: {
        "claude-opus-4-8[1m]": {
          inputTokens: 15681,
          outputTokens: 4,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 23794,
          costUSD: 0.227,
          contextWindow: 1000000,
          maxOutputTokens: 64000,
        },
      },
    };
    const u = extractUsage(evt);
    expect(u.promptTokens).toBe(39475);
    expect(u.contextWindow).toBe(1000000);
    expect(u.costUsd).toBeCloseTo(0.227, 6);
  });

  test("result event with no usage/modelUsage yields zeros/null, no throw", () => {
    const evt = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "sess-2",
      num_turns: 0,
    };
    const u = extractUsage(evt);
    expect(u.promptTokens).toBe(0);
    expect(u.contextWindow).toBeNull();
    expect(u.costUsd).toBe(0);
  });

  test("missing usage but total_cost_usd present still reports cost", () => {
    const evt = { type: "result", total_cost_usd: 0.5 };
    const u = extractUsage(evt);
    expect(u.promptTokens).toBe(0);
    expect(u.contextWindow).toBeNull();
    expect(u.costUsd).toBe(0.5);
  });

  test("missing usage sub-fields treated as 0", () => {
    const evt = { type: "result", usage: { input_tokens: 100 } };
    const u = extractUsage(evt);
    expect(u.promptTokens).toBe(100);
  });

  test("multiple modelUsage entries: takes max contextWindow", () => {
    const evt = {
      type: "result",
      modelUsage: {
        "model-a": { contextWindow: 200000, costUSD: 0.1 },
        "model-b": { contextWindow: 1000000, costUSD: 0.2 },
      },
    };
    const u = extractUsage(evt);
    expect(u.contextWindow).toBe(1000000);
  });

  test("no total_cost_usd: sums modelUsage costUSD", () => {
    const evt = {
      type: "result",
      modelUsage: {
        "model-a": { contextWindow: 200000, costUSD: 0.1 },
        "model-b": { contextWindow: 1000000, costUSD: 0.2 },
      },
    };
    const u = extractUsage(evt);
    expect(u.costUsd).toBeCloseTo(0.3, 6);
  });
});
