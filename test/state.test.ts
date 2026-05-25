import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSession, saveSession, loadState, saveState } from "../lib/state.ts";

let tmpDir: string;
let sessionFile: string;
let stateFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "albus-state-"));
  sessionFile = join(tmpDir, "session.json");
  stateFile = join(tmpDir, "state.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadSession", () => {
  test("missing file returns null", () => {
    expect(loadSession(sessionFile)).toBeNull();
  });

  test("corrupt JSON returns null without throwing", () => {
    writeFileSync(sessionFile, "{not json");
    expect(loadSession(sessionFile)).toBeNull();
  });

  test("empty session_id field returns null", () => {
    writeFileSync(sessionFile, JSON.stringify({ session_id: null }));
    expect(loadSession(sessionFile)).toBeNull();
  });

  test("populated session_id round-trips", () => {
    saveSession(sessionFile, "abc-123-uuid");
    expect(loadSession(sessionFile)).toBe("abc-123-uuid");
  });
});

describe("saveSession", () => {
  test("writes session_id and updated_at when id is non-null", () => {
    saveSession(sessionFile, "my-session");
    const raw = JSON.parse(
      // intentionally re-read raw to verify shape
      require("node:fs").readFileSync(sessionFile, "utf8")
    );
    expect(raw.session_id).toBe("my-session");
    expect(typeof raw.updated_at).toBe("string");
  });

  test("clearing with null writes reset_at marker", () => {
    saveSession(sessionFile, "first");
    saveSession(sessionFile, null);
    const raw = JSON.parse(require("node:fs").readFileSync(sessionFile, "utf8"));
    expect(raw.session_id).toBeNull();
    expect(typeof raw.reset_at).toBe("string");
  });

  test("overwriting an existing file replaces contents cleanly", () => {
    saveSession(sessionFile, "old");
    saveSession(sessionFile, "new");
    expect(loadSession(sessionFile)).toBe("new");
  });
});

describe("loadState", () => {
  test("missing file returns default {unlocked: false}", () => {
    expect(loadState(stateFile)).toEqual({ unlocked: false });
  });

  test("corrupt JSON returns default without throwing", () => {
    writeFileSync(stateFile, "{broken");
    expect(loadState(stateFile)).toEqual({ unlocked: false });
  });

  test("populated state round-trips", () => {
    const now = new Date().toISOString();
    saveState(stateFile, { unlocked: true, unlocked_at: now });
    expect(loadState(stateFile)).toEqual({ unlocked: true, unlocked_at: now });
  });
});

describe("saveState", () => {
  test("locked state writes just the unlocked flag", () => {
    saveState(stateFile, { unlocked: false });
    expect(loadState(stateFile)).toEqual({ unlocked: false });
  });

  test("toggling unlocked->locked drops unlocked_at when caller omits it", () => {
    saveState(stateFile, { unlocked: true, unlocked_at: "2026-01-01T00:00:00Z" });
    saveState(stateFile, { unlocked: false });
    const after = loadState(stateFile);
    expect(after.unlocked).toBe(false);
    expect(after.unlocked_at).toBeUndefined();
  });
});
