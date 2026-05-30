// test/quick-args.test.ts
import { describe, expect, test } from "bun:test";
import { buildQuickArgs } from "../lib/claude.ts";

describe("buildQuickArgs", () => {
  const args = buildQuickArgs({ system: "VOICE CARD", model: "claude-haiku-4-5" });

  test("never resumes a session", () => {
    expect(args).not.toContain("--resume");
  });
  test("loads no skills (empty setting-sources)", () => {
    const i = args.indexOf("--setting-sources");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("");
  });
  test("disables MCP", () => {
    const i = args.indexOf("--mcp-config");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('{"mcpServers":{}}');
    expect(args).toContain("--strict-mcp-config");
  });
  test("passes the voice card as the system prompt", () => {
    const i = args.indexOf("--append-system-prompt");
    expect(args[i + 1]).toBe("VOICE CARD");
  });
  test("passes the model and json output", () => {
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5");
    const o = args.indexOf("--output-format");
    expect(args[o + 1]).toBe("json");
  });
});
