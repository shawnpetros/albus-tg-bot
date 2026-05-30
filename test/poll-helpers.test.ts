import { describe, expect, test } from "bun:test";
import {
  shouldCompact,
  looksLikeSessionLoss,
  SeenUpdates,
  getUpdatesBackoffMs,
  shouldSynthesizeVoice,
  selectVoiceText,
} from "../lib/poll.ts";
import { backoffDelayMs } from "../lib/telegram.ts";
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

describe("SeenUpdates (inbound dedup)", () => {
  test("first sight is not a duplicate, repeat is", () => {
    const s = new SeenUpdates(200);
    expect(s.isDuplicate(42)).toBe(false);
    s.add(42);
    expect(s.isDuplicate(42)).toBe(true);
  });

  test("distinct ids are independent", () => {
    const s = new SeenUpdates(200);
    s.add(1);
    expect(s.isDuplicate(1)).toBe(true);
    expect(s.isDuplicate(2)).toBe(false);
  });

  test("re-adding an id does not grow the buffer", () => {
    const s = new SeenUpdates(200);
    s.add(7);
    s.add(7);
    s.add(7);
    expect(s.size).toBe(1);
  });

  test("buffer stays bounded and evicts oldest (FIFO)", () => {
    const cap = 5;
    const s = new SeenUpdates(cap);
    for (let i = 0; i < 100; i++) s.add(i);
    expect(s.size).toBe(cap);
    // Oldest (0..94) evicted; the last `cap` ids remain.
    expect(s.isDuplicate(0)).toBe(false);
    expect(s.isDuplicate(94)).toBe(false);
    expect(s.isDuplicate(95)).toBe(true);
    expect(s.isDuplicate(99)).toBe(true);
  });
});

describe("shouldSynthesizeVoice (deterministic voice-on-voice gate)", () => {
  // The happy path: inbound was voice, both env vars present, no agent mp3.
  test("true when voice + api key + voice id + no existing mp3", () => {
    expect(shouldSynthesizeVoice(true, true, true, false)).toBe(true);
  });

  test("false when the inbound turn was not a voice memo", () => {
    expect(shouldSynthesizeVoice(false, true, true, false)).toBe(false);
  });

  test("false when the API key is missing", () => {
    expect(shouldSynthesizeVoice(true, false, true, false)).toBe(false);
  });

  test("false when the voice id is missing", () => {
    expect(shouldSynthesizeVoice(true, true, false, false)).toBe(false);
  });

  test("false when the agent already wrote a reply.mp3 (no double-send)", () => {
    expect(shouldSynthesizeVoice(true, true, true, true)).toBe(false);
  });

  test("false when nothing lines up", () => {
    expect(shouldSynthesizeVoice(false, false, false, true)).toBe(false);
  });
});

describe("429 backoff delay", () => {
  test("getUpdates honors retry_after (capped at 60s)", () => {
    expect(getUpdatesBackoffMs(2)).toBe(2000);
    expect(getUpdatesBackoffMs(120)).toBe(60_000);
  });

  test("getUpdates falls back to flat 5s without retry_after", () => {
    expect(getUpdatesBackoffMs()).toBe(5000);
    expect(getUpdatesBackoffMs(0)).toBe(5000);
  });

  test("send path honors retry_after over exponential backoff", () => {
    expect(backoffDelayMs(0, 4)).toBe(4000);
    expect(backoffDelayMs(3, 90)).toBe(60_000);
  });

  test("send path exponential backoff when no retry_after", () => {
    expect(backoffDelayMs(0)).toBe(3000);
    expect(backoffDelayMs(1)).toBe(6000);
    expect(backoffDelayMs(2)).toBe(12_000);
    // Capped at 60s.
    expect(backoffDelayMs(10)).toBe(60_000);
  });
});

describe("selectVoiceText (closing clip precedence)", () => {
  const full = "A".repeat(2000);

  test("prefers agent reply.voice.md", () => {
    expect(
      selectVoiceText({ agentVoiceMd: "spoken tldr", summary: "sum", fullReply: full, maxChars: 600 })
    ).toBe("spoken tldr");
  });
  test("falls back to the summary when no voice.md", () => {
    expect(
      selectVoiceText({ agentVoiceMd: null, summary: "the summary", fullReply: full, maxChars: 600 })
    ).toBe("the summary");
  });
  test("falls back to truncation when no voice.md and no summary", () => {
    const out = selectVoiceText({ agentVoiceMd: null, summary: null, fullReply: full, maxChars: 600 });
    expect(out).toBe("A".repeat(600));
  });
  test("returns null when there is nothing to say", () => {
    expect(
      selectVoiceText({ agentVoiceMd: "  ", summary: "", fullReply: "", maxChars: 600 })
    ).toBeNull();
  });
});
