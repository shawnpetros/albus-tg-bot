import { describe, expect, test } from "bun:test";
import { buildAckPrompt, buildSummaryPrompt } from "../lib/aside.ts";

describe("buildAckPrompt", () => {
  test("embeds the transcript", () => {
    const p = buildAckPrompt("rebuild the entire GTM pipeline tonight");
    expect(p).toContain("rebuild the entire GTM pipeline tonight");
  });
  test("instructs a single line and forbids recap", () => {
    const p = buildAckPrompt("hi");
    expect(p.toLowerCase()).toContain("one line");
  });
});

describe("buildSummaryPrompt", () => {
  test("embeds the reply and the char cap", () => {
    const p = buildSummaryPrompt("Here is a long considered answer.", 600);
    expect(p).toContain("Here is a long considered answer.");
    expect(p).toContain("600");
  });
});
