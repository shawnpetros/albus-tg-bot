import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeartbeat } from "../lib/heartbeat.ts";

let tmpDir: string;
let heartbeatFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "albus-hb-"));
  heartbeatFile = join(tmpDir, "heartbeat");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeHeartbeat", () => {
  test("creates the file when missing", () => {
    expect(existsSync(heartbeatFile)).toBe(false);
    writeHeartbeat(heartbeatFile);
    expect(existsSync(heartbeatFile)).toBe(true);
  });

  test("writes an ISO timestamp body", () => {
    writeHeartbeat(heartbeatFile);
    const body = readFileSync(heartbeatFile, "utf8").trim();
    // Loose ISO check; format is YYYY-MM-DDTHH:MM:SS.mmmZ
    expect(body).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("updates mtime on repeated calls", async () => {
    writeHeartbeat(heartbeatFile);
    const first = statSync(heartbeatFile).mtimeMs;
    await new Promise((r) => setTimeout(r, 12));
    writeHeartbeat(heartbeatFile);
    const second = statSync(heartbeatFile).mtimeMs;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  test("does not throw when path is unwritable (caller-survival contract)", () => {
    // /dev/null/heartbeat is guaranteed unwritable on macOS+Linux.
    expect(() => writeHeartbeat("/dev/null/heartbeat")).not.toThrow();
  });
});
