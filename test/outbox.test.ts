import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushOutbox, sweepOrphanOutboxes, type OutboxDeps } from "../lib/outbox.ts";
import { utimesSync } from "node:fs";

interface SendCall {
  path: string;
  caption: string | undefined;
}
interface MessageCall {
  text: string;
  markdown?: boolean;
}

function makeDeps(opts: { failOn?: string } = {}): {
  deps: OutboxDeps;
  sent: SendCall[];
  messaged: MessageCall[];
} {
  const sent: SendCall[] = [];
  const messaged: MessageCall[] = [];
  const deps: OutboxDeps = {
    sendAttachment: async (path, caption) => {
      if (opts.failOn && path.endsWith(opts.failOn)) {
        throw new Error(`mock failure on ${opts.failOn}`);
      }
      sent.push({ path, caption });
      return { ok: true };
    },
    sendMessage: async (text, msgOpts) => {
      messaged.push({ text, markdown: msgOpts?.markdown });
    },
  };
  return { deps, sent, messaged };
}

let workDir: string;
let turnDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "albus-outbox-"));
  turnDir = join(workDir, "42");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("flushOutbox - empty + missing", () => {
  test("missing dir returns 0 and does not throw", async () => {
    const { deps, sent } = makeDeps();
    expect(await flushOutbox(turnDir, deps)).toBe(0);
    expect(sent).toEqual([]);
  });

  test("empty dir returns 0 and cleans up", async () => {
    mkdirSync(turnDir, { recursive: true });
    const { deps, sent } = makeDeps();
    expect(await flushOutbox(turnDir, deps)).toBe(0);
    expect(sent).toEqual([]);
    expect(existsSync(turnDir)).toBe(false);
  });
});

describe("flushOutbox - file delivery", () => {
  test("one regular file is sent without caption", async () => {
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(join(turnDir, "reply.md"), "# hi");
    const { deps, sent } = makeDeps();
    expect(await flushOutbox(turnDir, deps)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(join(turnDir, "reply.md"));
    expect(sent[0]?.caption).toBeUndefined();
  });

  test("sibling .caption.txt provides the caption and is not itself sent", async () => {
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(join(turnDir, "summary.md"), "# hi");
    writeFileSync(join(turnDir, "summary.md.caption.txt"), "  here's the summary  \n");
    const { deps, sent } = makeDeps();
    expect(await flushOutbox(turnDir, deps)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.caption).toBe("here's the summary");
  });

  test("hidden files (dot-prefixed) are skipped", async () => {
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(join(turnDir, ".DS_Store"), "junk");
    writeFileSync(join(turnDir, "real.txt"), "content");
    const { deps, sent } = makeDeps();
    expect(await flushOutbox(turnDir, deps)).toBe(1);
    expect(sent.map((s) => s.path)).toEqual([join(turnDir, "real.txt")]);
  });

  test("multiple files: all delivered, returns count", async () => {
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(join(turnDir, "a.md"), "a");
    writeFileSync(join(turnDir, "b.png"), "b");
    writeFileSync(join(turnDir, "c.pdf"), "c");
    const { deps, sent } = makeDeps();
    expect(await flushOutbox(turnDir, deps)).toBe(3);
    expect(sent).toHaveLength(3);
  });

  test("dir is removed after successful flush", async () => {
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(join(turnDir, "f.txt"), "x");
    const { deps } = makeDeps();
    await flushOutbox(turnDir, deps);
    expect(existsSync(turnDir)).toBe(false);
  });
});

describe("sweepOrphanOutboxes", () => {
  // Age a path so it clears the min-age guard (utimes wants seconds).
  function makeStale(path: string) {
    const old = (Date.now() - 10 * 60 * 1000) / 1000;
    utimesSync(path, old, old);
  }

  test("missing parent returns 0", async () => {
    const { deps } = makeDeps();
    expect(await sweepOrphanOutboxes(join(workDir, "nope"), turnDir, deps)).toBe(0);
  });

  test("delivers files from a stale orphan dir and removes it", async () => {
    const orphan = join(workDir, "99");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "stranded.md"), "lost");
    makeStale(orphan);
    const { deps, sent } = makeDeps();
    expect(await sweepOrphanOutboxes(workDir, turnDir, deps)).toBe(1);
    expect(sent[0]?.path).toBe(join(orphan, "stranded.md"));
    expect(existsSync(orphan)).toBe(false);
  });

  test("skips the current turn dir", async () => {
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(join(turnDir, "current.md"), "keep");
    makeStale(turnDir);
    const { deps, sent } = makeDeps();
    expect(await sweepOrphanOutboxes(workDir, turnDir, deps)).toBe(0);
    expect(sent).toEqual([]);
    expect(existsSync(turnDir)).toBe(true); // untouched by the sweep
  });

  test("skips dirs newer than minAge (possible in-flight turn)", async () => {
    const fresh = join(workDir, "100");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "wip.md"), "in flight");
    // not aged: mtime is ~now
    const { deps, sent } = makeDeps();
    expect(await sweepOrphanOutboxes(workDir, turnDir, deps)).toBe(0);
    expect(sent).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });

  test("ignores loose files (e.g. ack-*.ogg), only sweeps dirs", async () => {
    writeFileSync(join(workDir, "ack-42.ogg"), "audio");
    const orphan = join(workDir, "77");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "doc.pdf"), "x");
    makeStale(orphan);
    const { deps, sent } = makeDeps();
    expect(await sweepOrphanOutboxes(workDir, turnDir, deps)).toBe(1);
    expect(sent.map((s) => s.path)).toEqual([join(orphan, "doc.pdf")]);
    expect(existsSync(join(workDir, "ack-42.ogg"))).toBe(true); // loose file untouched
  });
});

describe("flushOutbox - failures", () => {
  test("failed sendAttachment posts an error message and continues", async () => {
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(join(turnDir, "ok.txt"), "ok");
    writeFileSync(join(turnDir, "bad.txt"), "bad");
    const { deps, sent, messaged } = makeDeps({ failOn: "bad.txt" });
    expect(await flushOutbox(turnDir, deps)).toBe(1); // only 'ok' counted
    expect(sent.map((s) => s.path.split("/").pop())).toEqual(["ok.txt"]);
    expect(messaged).toHaveLength(1);
    expect(messaged[0]?.text).toContain("bad.txt");
    expect(messaged[0]?.markdown).toBe(false);
  });
});
