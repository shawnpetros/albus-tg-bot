import { describe, expect, test } from "bun:test";
import { handleSlashCommand, type SlashDeps } from "../lib/slash.ts";
import type { BotState, SessionRecord } from "../lib/state.ts";

// Build a deps object with sensible defaults and capture sent messages plus
// compaction requests. Override any field per-test.
function makeDeps(over: Partial<SlashDeps> = {}): {
  deps: SlashDeps;
  sent: string[];
  compactCalls: number;
} {
  const sent: string[] = [];
  let compactCalls = 0;
  const deps: SlashDeps = {
    getSession: () => null,
    clearSession: () => {},
    getState: () => ({ unlocked: false }) as BotState,
    setUnlocked: () => {},
    getSessionRecord: () => null,
    requestCompact: () => {
      compactCalls++;
    },
    sendMessage: async (text: string) => {
      sent.push(text);
    },
    ...over,
  };
  return {
    deps,
    sent,
    get compactCalls() {
      return compactCalls;
    },
  } as { deps: SlashDeps; sent: string[]; compactCalls: number };
}

describe("/status stats", () => {
  test("includes turns, approx context, cost, and age when a record is present", async () => {
    const created = new Date(Date.now() - (2 * 60 * 60 + 13 * 60) * 1000).toISOString();
    const rec: SessionRecord = {
      session_id: "sess-abc",
      created_at: created,
      turns: 7,
      last_prompt_tokens: 42_300,
      total_cost_usd: 0.1234,
    };
    const { deps, sent } = makeDeps({
      getSession: () => "sess-abc",
      getSessionRecord: () => rec,
    });
    const handled = await handleSlashCommand("/status", deps);
    expect(handled).toBe(true);
    const out = sent.join("\n");
    expect(out).toContain("7"); // turns
    expect(out).toContain("~42k tokens");
    expect(out).toContain("$0.1234");
    expect(out).toContain("2h 13m");
  });

  test("degrades gracefully when no record present", async () => {
    const { deps, sent } = makeDeps({
      getSession: () => null,
      getSessionRecord: () => null,
    });
    const handled = await handleSlashCommand("/status", deps);
    expect(handled).toBe(true);
    const out = sent.join("\n");
    // Should not throw and should still report a session line + mode.
    expect(out).toContain("Session:");
    expect(out).toContain("Mode:");
  });

  test("handles a record present but missing accounting fields", async () => {
    const rec: SessionRecord = { session_id: "sess-legacy" };
    const { deps, sent } = makeDeps({
      getSession: () => "sess-legacy",
      getSessionRecord: () => rec,
    });
    const handled = await handleSlashCommand("/status", deps);
    expect(handled).toBe(true);
    const out = sent.join("\n");
    expect(out).toContain("Session: sess-legacy");
    // Missing fields render as a placeholder, not "undefined" or "NaN".
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
  });
});

describe("/compact", () => {
  test("requests a compaction and confirms when a session exists", async () => {
    let calls = 0;
    const { deps, sent } = makeDeps({
      getSession: () => "sess-abc",
      getSessionRecord: () => ({ session_id: "sess-abc", last_prompt_tokens: 5000 }),
      requestCompact: () => {
        calls++;
      },
    });
    const handled = await handleSlashCommand("/compact", deps);
    expect(handled).toBe(true);
    expect(calls).toBe(1);
    expect(sent.join("\n").toLowerCase()).toContain("compact");
  });

  test("does not enqueue when there is no current session", async () => {
    let calls = 0;
    const { deps, sent } = makeDeps({
      getSession: () => null,
      getSessionRecord: () => null,
      requestCompact: () => {
        calls++;
      },
    });
    const handled = await handleSlashCommand("/compact", deps);
    expect(handled).toBe(true);
    expect(calls).toBe(0);
    expect(sent.join("\n").toLowerCase()).toContain("nothing to compact");
  });
});
