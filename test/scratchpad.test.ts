import { describe, expect, test } from "bun:test";
import { createScratchpad, type ScratchpadDeps } from "../lib/scratchpad.ts";

interface Call {
  method: string;
  body: any;
}

function makeDeps(opts: { minStreamChars?: number } = {}): {
  deps: ScratchpadDeps;
  calls: Call[];
} {
  const calls: Call[] = [];
  let nextId = 100;
  const deps: ScratchpadDeps = {
    chatId: 1,
    minStreamChars: opts.minStreamChars,
    send: async (method, body) => {
      calls.push({ method, body });
      if (method === "sendMessage") return { message_id: nextId++ };
      return { ok: true };
    },
  };
  return { deps, calls };
}

// Let queued microtasks (the fire-and-forget open) settle.
const microflush = () => new Promise((r) => setTimeout(r, 0));
// Wait past the 1500ms edit debounce.
const afterDebounce = () => new Promise((r) => setTimeout(r, 1700));

const opens = (calls: Call[]) => calls.filter((c) => c.method === "sendMessage");
const edits = (calls: Call[]) => calls.filter((c) => c.method === "editMessageText");

describe("scratchpad streamText", () => {
  test("does not open the live message for a reply below minStreamChars", async () => {
    const { deps, calls } = makeDeps({ minStreamChars: 240 });
    const sp = createScratchpad(deps);
    sp.streamText("short reply");
    await microflush();
    expect(opens(calls).length).toBe(0);
  });

  test("opens once it crosses minStreamChars, and only once under a delta flood", async () => {
    const { deps, calls } = makeDeps({ minStreamChars: 10 });
    const sp = createScratchpad(deps);
    // Simulate the rapid one-call-per-delta stream that would race ensureOpen.
    for (let i = 1; i <= 50; i++) sp.streamText("x".repeat(i));
    await microflush();
    expect(opens(calls).length).toBe(1);
  });

  test("renders the streamed text tail in the live edit", async () => {
    const { deps, calls } = makeDeps({ minStreamChars: 5 });
    const sp = createScratchpad(deps);
    sp.streamText("the quick brown fox jumps");
    await microflush();
    await afterDebounce();
    const lastEdit = edits(calls).at(-1);
    expect(lastEdit?.body.text).toContain("jumps");
  });
});

describe("scratchpad onToolUse", () => {
  test("opens immediately on first tool regardless of length", async () => {
    const { deps, calls } = makeDeps({ minStreamChars: 9999 });
    const sp = createScratchpad(deps);
    sp.onToolUse("⚙️ running: thing");
    await microflush();
    expect(opens(calls).length).toBe(1);
  });

  test("streamed text takes over the message from tool lines", async () => {
    const { deps, calls } = makeDeps({ minStreamChars: 5 });
    const sp = createScratchpad(deps);
    sp.onToolUse("🔍 searching");
    await microflush();
    sp.streamText("here is the actual reply text forming");
    await afterDebounce();
    const lastEdit = edits(calls).at(-1);
    expect(lastEdit?.body.text).toContain("actual reply text");
    expect(lastEdit?.body.text).not.toContain("searching");
  });
});

describe("scratchpad close", () => {
  test("deletes the live message exactly once", async () => {
    const { deps, calls } = makeDeps({ minStreamChars: 1 });
    const sp = createScratchpad(deps);
    sp.streamText("opening this up");
    await microflush();
    await sp.close();
    await sp.close();
    expect(calls.filter((c) => c.method === "deleteMessage").length).toBe(1);
  });
});
