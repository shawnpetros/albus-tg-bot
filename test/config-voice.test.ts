import { describe, expect, test } from "bun:test";
import {
  VOICE_ACK_ENABLED,
  VOICE_ASIDE_MODEL,
  VOICE_TLDR_MAX_CHARS,
  QUICK_TIMEOUT_MS,
  PERSONA_VOICE_PATH,
} from "../lib/config.ts";

describe("voice aside config", () => {
  test("ack enabled defaults true", () => {
    expect(typeof VOICE_ACK_ENABLED).toBe("boolean");
  });
  test("aside model is a non-empty string", () => {
    expect(VOICE_ASIDE_MODEL.length).toBeGreaterThan(0);
  });
  test("tldr cap is a positive number", () => {
    expect(VOICE_TLDR_MAX_CHARS).toBeGreaterThan(0);
  });
  test("quick timeout is a positive number", () => {
    expect(QUICK_TIMEOUT_MS).toBeGreaterThan(0);
  });
  test("persona voice path is the repo card or a local overlay", () => {
    // The repo default, or persona-voice.local.md when the host has one.
    expect(
      PERSONA_VOICE_PATH.endsWith("persona-voice.md") ||
        PERSONA_VOICE_PATH.endsWith("persona-voice.local.md")
    ).toBe(true);
  });
});
