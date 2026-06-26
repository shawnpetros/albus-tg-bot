# Voice Memo Fast-Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A voice memo gets an immediate in-character spoken acknowledgement before the heavy pass runs, and the closing voice clip speaks a short TL;DR instead of reading the full reply aloud.

**Architecture:** Two throwaway, sessionless, toolless `claude -p` calls on a fast model (the "asides") bracket the existing heavy turn: a `quickAck` before enqueue, a `voiceSummary` fallback after. Personality lives in a small few-shot voice card (`persona-voice.md`) that both asides load via `--append-system-prompt`. The asides never touch the main session id, so single-flight on the real session is untouched.

**Tech Stack:** Bun + TypeScript, `bun test`, `bunx tsc --noEmit`, the `claude` CLI (headless `-p`), ElevenLabs TTS/STT (already wired in `lib/elevenlabs.ts`), Telegram Bot API (`lib/telegram.ts`).

**Spec:** `docs/superpowers/specs/2026-05-29-voice-memo-fast-path-design.md`

---

## Model assignment (per Shawn's topology)

- **Opus** — orchestrator (the controller running this plan). Intervenes only when a worker is BLOCKED or a reviewer flags weak output: re-scopes the task, rewrites the prompt, or re-dispatches on a stronger model. Co-judges the bake-off.
- **Sonnet** — both review stages (spec compliance, then code quality) for every task. Also the implementer for integration/judgment tasks (2, 6, 7).
- **Haiku** — implementer for mechanical, single-file, fully-specified tasks (1, 4, 8, and the builder half of 3).
- **Bake-off (Task 5)** — dispatched to BOTH a Haiku and a Sonnet implementer independently; Opus + a Sonnet reviewer pick the better artifact.

If a Haiku worker returns BLOCKED or its output fails the spec reviewer twice, re-dispatch the same task on Sonnet rather than looping Haiku.

## Validation gate (EVERY task, non-negotiable)

A task is not done until both pass, with output pasted into the task record:

```bash
cd ~/projects/albus-tg-bot
bun test          # all suites green
bunx tsc --noEmit # zero type errors
```

Plus the task's own named test(s) passing. Commit only after both gates are green.

## File structure

- **Modify** `lib/config.ts` — three voice-aside config knobs + `QUICK_TIMEOUT_MS` + `PERSONA_VOICE_PATH`.
- **Modify** `lib/claude.ts` — add pure `buildQuickArgs` + `spawnQuick` wrapper.
- **Create** `lib/aside.ts` — `ACK_INSTRUCTION`, `SUMMARY_INSTRUCTION`, `buildAckPrompt`, `buildSummaryPrompt`, `loadVoiceCard`, `quickAck`, `voiceSummary`.
- **Create** `persona-voice.md` — the few-shot personality card (committed; no operator identity).
- **Modify** `lib/poll.ts` — add pure `selectVoiceText`; fire the ack in `handleUpdate`; replace the truncation in `processMessage`.
- **Modify** `persona.md` — instruct Albus to also write `reply.voice.md` on voice turns.
- **Create** `test/aside.test.ts`; **Modify** `test/poll-helpers.test.ts`.

---

## Task 1: Config knobs

**Model:** Haiku

**Files:**
- Modify: `lib/config.ts` (add near the voice block at lines 96-97)
- Test: `test/config-voice.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// test/config-voice.test.ts
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
  test("persona voice path ends with persona-voice.md", () => {
    expect(PERSONA_VOICE_PATH.endsWith("persona-voice.md")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config-voice.test.ts`
Expected: FAIL — imports undefined (`VOICE_ACK_ENABLED` etc. not exported).

- [ ] **Step 3: Add the config exports**

Add to `lib/config.ts`, just after line 97 (`export const ALBUS_VOICE_ID = ...`). Note `PERSONA_VOICE_PATH` uses the existing `resolve` and `PROJECT_ROOT` already imported/defined in this file:

```ts
// --- Voice aside fast-path (see specs/2026-05-29-voice-memo-fast-path) ---
// Kill switch for the voice ack + spoken-TLDR fast-path. Default on.
export const VOICE_ACK_ENABLED =
  (process.env.ALBUS_VOICE_ACK_ENABLED ?? "true").toLowerCase() !== "false";
// Fixed fast model for both asides, independent of the session /model setting.
export const VOICE_ASIDE_MODEL =
  process.env.ALBUS_VOICE_ASIDE_MODEL || "claude-haiku-4-5";
// Spoken TL;DR char cap (~30s of speech). Replaces the old 1500 truncation
// for the summary path.
export const VOICE_TLDR_MAX_CHARS =
  Number(process.env.ALBUS_VOICE_TLDR_MAX_CHARS) || 600;
// Hard timeout for an aside call. Asides are best-effort and must never hang.
export const QUICK_TIMEOUT_MS =
  Number(process.env.ALBUS_QUICK_TIMEOUT_MS) || 30_000;
// The few-shot personality card both asides load as their system prompt.
export const PERSONA_VOICE_PATH = resolve(PROJECT_ROOT, "persona-voice.md");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/config-voice.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Full gate + commit**

```bash
bun test && bunx tsc --noEmit
git add lib/config.ts test/config-voice.test.ts
git commit -m "feat(voice): config knobs for the ack/TLDR fast-path"
```

---

## Task 2: `spawnQuick` — stripped fast `claude -p` primitive

**Model:** Sonnet (child_process + JSON parse + arg-stripping judgment)

**Files:**
- Modify: `lib/claude.ts` (add after `compactSession`, ~line 343)
- Test: `test/quick-args.test.ts` (create)

The testable surface is the pure arg builder. The spawn wrapper is thin and integration-only (like `spawnAlbus`/`compactSession`, which are not unit-tested).

- [ ] **Step 1: Confirm CLI flag spelling**

Run: `claude --help | grep -E "setting-sources|mcp-config|strict"`
Expected: confirms `--setting-sources`, `--mcp-config`, `--strict-mcp-config` exist. If any flag name differs in this CLI version, use the actual name and update both the code and the test in lockstep below.

- [ ] **Step 2: Write the failing test**

```ts
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
    expect(args[i + 1]).toBe("{}");
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/quick-args.test.ts`
Expected: FAIL — `buildQuickArgs` not exported.

- [ ] **Step 4: Implement `buildQuickArgs` + `spawnQuick`**

Add to `lib/claude.ts`. `QUICK_TIMEOUT_MS` is imported from config; add it to the existing config import line at the top of the file.

```ts
export interface QuickOptions {
  input: string;
  system: string;
  model: string;
}

// Pure: the arg vector for a stripped, sessionless, toolless aside call.
// No --resume (no session replay), empty --setting-sources (no skills),
// --mcp-config '{}' + --strict-mcp-config (no MCP servers). These three are
// the entire latency win; the system prompt (voice card) is essentially free.
export function buildQuickArgs(opts: { system: string; model: string }): string[] {
  return [
    "-p",
    "--append-system-prompt",
    opts.system,
    "--model",
    opts.model,
    "--output-format",
    "json",
    "--setting-sources",
    "",
    "--mcp-config",
    "{}",
    "--strict-mcp-config",
  ];
}

// Run a stripped fast aside. Returns the reply text on a clean exit; rejects on
// timeout, non-zero exit, or unparseable output. Callers treat it best-effort.
export function spawnQuick(opts: QuickOptions): Promise<string> {
  const { input, system, model } = opts;
  return new Promise((resolveP, rejectP) => {
    const child = spawn("claude", buildQuickArgs({ system, model }), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectP(err);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`quick aside timed out after ${QUICK_TIMEOUT_MS / 1000}s`));
    }, QUICK_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e: Error) => fail(e));
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectP(new Error(`quick aside exited ${code}: ${stderr.slice(-300) || "no stderr"}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: string };
        resolveP(parsed.result || "");
      } catch {
        rejectP(new Error(`quick aside: unparseable output: ${stdout.slice(0, 200)}`));
      }
    });

    child.stdin?.write(input);
    child.stdin?.end();
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/quick-args.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Full gate + commit**

```bash
bun test && bunx tsc --noEmit
git add lib/claude.ts test/quick-args.test.ts
git commit -m "feat(voice): spawnQuick stripped fast-model primitive"
```

---

## Task 3: `lib/aside.ts` — prompt builders + aside wrappers

**Model:** Haiku (mechanical assembly; the personality wording is deferred to Task 5)

**Files:**
- Create: `lib/aside.ts`
- Test: `test/aside.test.ts` (create)

`ACK_INSTRUCTION` and `SUMMARY_INSTRUCTION` here are first-pass placeholders that Task 5 replaces with tuned wording. They must be non-empty and functional now.

- [ ] **Step 1: Write the failing test**

```ts
// test/aside.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/aside.test.ts`
Expected: FAIL — module `../lib/aside.ts` not found.

- [ ] **Step 3: Implement `lib/aside.ts`**

```ts
// Voice asides: a fast in-character ack before the heavy turn, and a spoken
// TL;DR fallback after it. Both run via spawnQuick (stripped, sessionless,
// fast model) with the persona-voice card as the system prompt. Pure prompt
// builders are exported for unit testing; the spawn wrappers are best-effort.

import { existsSync, readFileSync } from "node:fs";
import { spawnQuick } from "./claude.ts";
import {
  VOICE_ASIDE_MODEL,
  VOICE_TLDR_MAX_CHARS,
  PERSONA_VOICE_PATH,
} from "./config.ts";

// First-pass wording. Task 5 (bake-off) replaces these with tuned text.
export const ACK_INSTRUCTION =
  "Reply in ONE line, in character, reacting to the shape and ambition of what the operator just asked. " +
  "A long-winded build-out earns a dry, weary quip; a one-line question earns a deadpan beat. " +
  "Do NOT summarize the request back. Do NOT say you will start or 'get on it' literally. " +
  "Do NOT attempt to answer anything that needs tools, files, or memory. Just the aside.";

export const SUMMARY_INSTRUCTION =
  "Condense the reply below into a short spoken TL;DR in the operator's assistant voice. " +
  "Two or three sentences, plain spoken prose, faithful to the reply, nothing the reply does not say.";

let cachedCard: string | null = null;
// Loads the persona-voice card once. Missing file degrades gracefully to an
// empty system prompt (asides still run, just with less flavour).
export function loadVoiceCard(): string {
  if (cachedCard !== null) return cachedCard;
  try {
    cachedCard = existsSync(PERSONA_VOICE_PATH)
      ? readFileSync(PERSONA_VOICE_PATH, "utf8")
      : "";
  } catch {
    cachedCard = "";
  }
  return cachedCard;
}

export function buildAckPrompt(transcript: string): string {
  return (
    `${ACK_INSTRUCTION}\n\n` +
    `The operator just sent this voice memo:\n"""\n${transcript.trim()}\n"""\n\n` +
    `Your one-line reply:`
  );
}

export function buildSummaryPrompt(replyText: string, maxChars: number): string {
  return (
    `${SUMMARY_INSTRUCTION} Keep it under ${maxChars} characters.\n\n` +
    `Reply to condense:\n"""\n${replyText.trim()}\n"""\n\n` +
    `Spoken TL;DR:`
  );
}

// Best-effort: callers wrap in try/catch. Returns the spoken text.
export async function quickAck(transcript: string): Promise<string> {
  const out = await spawnQuick({
    input: buildAckPrompt(transcript),
    system: loadVoiceCard(),
    model: VOICE_ASIDE_MODEL,
  });
  return out.trim();
}

export async function voiceSummary(replyText: string): Promise<string> {
  const out = await spawnQuick({
    input: buildSummaryPrompt(replyText, VOICE_TLDR_MAX_CHARS),
    system: loadVoiceCard(),
    model: VOICE_ASIDE_MODEL,
  });
  return out.trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/aside.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full gate + commit**

```bash
bun test && bunx tsc --noEmit
git add lib/aside.ts test/aside.test.ts
git commit -m "feat(voice): aside prompt builders + quickAck/voiceSummary"
```

---

## Task 4: `selectVoiceText` — closing-clip precedence

**Model:** Haiku (pure function, fully specified)

**Files:**
- Modify: `lib/poll.ts` (add an exported pure function near `shouldSynthesizeVoice`, ~line 140)
- Test: `test/poll-helpers.test.ts` (extend)

Assumes the caller has already decided to synthesize (via `shouldSynthesizeVoice`). This picks WHICH text: agent-written `reply.voice.md` first, then the Haiku summary, then a truncation fallback.

- [ ] **Step 1: Write the failing test (append to `test/poll-helpers.test.ts`)**

Add `selectVoiceText` to the existing import from `../lib/poll.ts` at the top of the file, then append:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/poll-helpers.test.ts`
Expected: FAIL — `selectVoiceText` not exported.

- [ ] **Step 3: Implement `selectVoiceText` in `lib/poll.ts`**

Add just below `VOICE_SYNTH_MAX_CHARS` (~line 144):

```ts
// Pick the text for the closing voice clip, assuming we've already decided to
// synthesize (shouldSynthesizeVoice == true). Precedence: agent-written
// reply.voice.md, then the Haiku-generated summary, then a truncation of the
// full reply. Returns null if there is genuinely nothing to speak.
export function selectVoiceText(opts: {
  agentVoiceMd: string | null;
  summary: string | null;
  fullReply: string;
  maxChars: number;
}): string | null {
  if (opts.agentVoiceMd && opts.agentVoiceMd.trim()) return opts.agentVoiceMd.trim();
  if (opts.summary && opts.summary.trim()) return opts.summary.trim();
  const truncated = opts.fullReply.slice(0, opts.maxChars).trim();
  return truncated || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/poll-helpers.test.ts`
Expected: PASS (existing + 4 new).

- [ ] **Step 5: Full gate + commit**

```bash
bun test && bunx tsc --noEmit
git add lib/poll.ts test/poll-helpers.test.ts
git commit -m "feat(voice): selectVoiceText closing-clip precedence"
```

---

## Task 5: BAKE-OFF — `persona-voice.md` card + tuned ack/summary wording

**Model:** Dispatch TWICE in parallel-of-effort (sequentially, no shared context): once Haiku, once Sonnet. Opus + a Sonnet reviewer judge and pick.

This is the personality task. There is no passing/failing test for taste; the gate is judgment plus "existing tests still green and the card loads."

**Files:**
- Create: `persona-voice.md` (committed; **NO operator identity** — no real name, email, or local paths. Refer to "the operator." Em dashes are contraband.)
- Modify: `lib/aside.ts` — replace `ACK_INSTRUCTION` and `SUMMARY_INSTRUCTION` with tuned wording.

- [ ] **Step 1: Dispatch implementer A (Haiku) with this brief**

Brief verbatim to the worker:
> Write `persona-voice.md`: a ~400-token personality card that will be used as the system prompt for one-line spoken asides from "Albus", a dry, senior, lightly-amused assistant (book-Dumbledore register, Jarvis/Friday deadpan, never zany, never cruel). Structure: (1) who Albus is in two breaths; (2) FIVE to SIX exemplar one-line acks in the exact target register, each reacting to a different kind of request (a long-winded build-out, a tiny question, a vague idea, a 2am impulse, a repeat of something already discussed). Seed exemplar to match the register of: "here we go again... shall I clear your evening?". (3) Hard rails: one line, react don't recap, dry not zany, no exclamation-mark hype, no emoji, no em dashes (use hyphens/commas/ellipses). Then in `lib/aside.ts`, tighten `ACK_INSTRUCTION` and `SUMMARY_INSTRUCTION` to match. NO operator real name, email, or filesystem paths anywhere. Run `bun test && bunx tsc --noEmit`; both must stay green. Do not commit; report the card contents and the two instruction strings.

- [ ] **Step 2: Dispatch implementer B (Sonnet) with the identical brief**

Same brief, fresh subagent, Sonnet. Do not show it A's output.

- [ ] **Step 3: Judge (Opus orchestrator + one Sonnet reviewer)**

Compare A vs B on: register accuracy (does it sound like the seed line, not generic wit?), exemplar diversity, and rail clarity. Pick the stronger card, or splice the better exemplars from each. Write the chosen `persona-voice.md` and the chosen instruction strings into `lib/aside.ts`.

- [ ] **Step 4: Verify the card loads and gate**

Run:
```bash
bun test && bunx tsc --noEmit
node -e "process.exit(require('fs').existsSync('persona-voice.md') && require('fs').readFileSync('persona-voice.md','utf8').trim().length > 200 ? 0 : 1)" && echo "card OK"
grep -nE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+|/Users/|shawnpetros| — " persona-voice.md && echo "LEAK/EMDASH FOUND - fix before commit" || echo "clean"
```
Expected: tests green, `card OK`, `clean`.

- [ ] **Step 5: Commit**

```bash
git add persona-voice.md lib/aside.ts
git commit -m "feat(voice): persona-voice card + tuned aside wording"
```

---

## Task 6: Fire the ack in `handleUpdate`

**Model:** Sonnet (integration into the live inbound flow)

**Files:**
- Modify: `lib/poll.ts` — imports, a `fireAck` helper inside `startBot`, and the voice branch of `handleUpdate`.

The ack is fire-and-forget (not awaited) so it overlaps the queued heavy turn. It is fully best-effort: any failure logs and is swallowed; enqueue always happens.

- [ ] **Step 1: Extend imports in `lib/poll.ts`**

Add to the existing `./elevenlabs.ts` import (already imports `transcribeAudio, synthesizeSpeech`): no change needed there. Add to the `./config.ts` import: `VOICE_ACK_ENABLED`, `OUTBOX_DIR` (if not already imported — it is). Add a new import:

```ts
import { quickAck, voiceSummary } from "./aside.ts";
import { VOICE_ACK_ENABLED, VOICE_TLDR_MAX_CHARS } from "./config.ts";
```
(Merge `VOICE_ACK_ENABLED, VOICE_TLDR_MAX_CHARS` into the existing config import line rather than duplicating it.) Also ensure `unlinkSync` is imported from `node:fs` alongside the existing fs imports.

- [ ] **Step 2: Capture the transcript in the voice branch**

In `handleUpdate`, the voice-transcription block (~lines 331-341) currently builds `transcriptLine`. Capture the raw transcript too. Change:

```ts
        let transcriptLine = "";
        if (mediaAttachment.kind === "voice" && ELEVENLABS_API_KEY) {
          try {
            const t = await transcribeAudio(localPath);
            if (t.text.trim()) {
              transcriptLine = `\n[voice transcript: ${t.text.trim()}]`;
            }
          } catch (e) {
```
to also stash the transcript on an outer-scoped variable declared just before the `try` at the top of `handleUpdate`'s body (alongside `let userInput`):

```ts
    let voiceTranscript = "";
```
and inside the success branch:

```ts
            if (t.text.trim()) {
              voiceTranscript = t.text.trim();
              transcriptLine = `\n[voice transcript: ${voiceTranscript}]`;
            }
```

- [ ] **Step 3: Add the `fireAck` helper inside `startBot`**

Place near `processMessage` (it uses `sendAttachment`, `synthesizeSpeech`, `ALBUS_VOICE_ID`, `ELEVENLABS_API_KEY`, `OUTBOX_DIR`, all in scope):

```ts
  // Best-effort, fire-and-forget in-character spoken ack. Runs as a stripped
  // fast-model call that overlaps the queued heavy turn. Never throws into the
  // caller; never blocks enqueue.
  async function fireAck(transcript: string, messageId: number): Promise<void> {
    const ackPath = `${OUTBOX_DIR}/ack-${messageId}.ogg`;
    try {
      const ackText = await quickAck(transcript);
      if (!ackText.trim()) return;
      const audio = await synthesizeSpeech(ackText, {
        voiceId: ALBUS_VOICE_ID!,
        outputFormat: "opus_48000_64",
      });
      writeFileSync(ackPath, audio);
      await sendAttachment(ackPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("voice ack failed (non-fatal):", msg);
    } finally {
      try {
        if (existsSync(ackPath)) unlinkSync(ackPath);
      } catch {
        /* temp cleanup is best-effort */
      }
    }
  }
```

- [ ] **Step 4: Fire it before enqueue**

In `handleUpdate`, immediately before the `queue.enqueue({...})` call (~line 358), add:

```ts
    if (
      mediaAttachment?.kind === "voice" &&
      VOICE_ACK_ENABLED &&
      voiceTranscript &&
      ELEVENLABS_API_KEY &&
      ALBUS_VOICE_ID
    ) {
      // Fire-and-forget: overlaps the queued heavy turn, lands in ~2-3s.
      void fireAck(voiceTranscript, msg.message_id);
    }
```

- [ ] **Step 5: Gate (no new unit test; ack path is integration)**

Run: `bun test && bunx tsc --noEmit`
Expected: all green, zero type errors. Confirm `OUTBOX_DIR` root is never scanned by `flushOutbox` (it scans `${OUTBOX_DIR}/${messageId}/`), so the temp ack file is never double-sent.

- [ ] **Step 6: Commit**

```bash
git add lib/poll.ts
git commit -m "feat(voice): fire in-character ack before the heavy turn"
```

---

## Task 7: Replace the truncation with the spoken TL;DR in `processMessage`

**Model:** Sonnet (integration; ordering to avoid a wasted summary call)

**Files:**
- Modify: `lib/poll.ts` — the voice-synthesis block in `processMessage` (~lines 447-469).

Order: if the agent wrote `reply.voice.md`, use it and SKIP the summary call. Otherwise call `voiceSummary` (best-effort). Then `selectVoiceText` picks the text; synthesize and write `reply.ogg` for `flushOutbox` to send.

- [ ] **Step 1: Rewrite the synthesis block**

Replace the current block (from `const replyOgg = ...` through the closing of the `if (shouldSynthesizeVoice(...))` body, ~lines 447-469) with:

```ts
      const replyOgg = `${turnOutbox}/reply.ogg`;
      const replyMp3 = `${turnOutbox}/reply.mp3`;
      const replyVoiceMd = `${turnOutbox}/reply.voice.md`;
      const agentWroteAudio = existsSync(replyOgg) || existsSync(replyMp3);
      if (
        shouldSynthesizeVoice(
          isVoice,
          Boolean(ELEVENLABS_API_KEY),
          Boolean(ALBUS_VOICE_ID),
          agentWroteAudio
        ) &&
        (result.reply || "").trim()
      ) {
        // Agent-written spoken TL;DR wins; only fall back to a Haiku summary
        // when it is absent (saves a call when Albus already gave us one).
        let agentVoiceMd: string | null = null;
        if (existsSync(replyVoiceMd)) {
          try {
            agentVoiceMd = readFileSync(replyVoiceMd, "utf8").trim() || null;
          } catch {
            agentVoiceMd = null;
          }
        }
        let summary: string | null = null;
        if (!agentVoiceMd) {
          try {
            summary = await voiceSummary(result.reply);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn("voiceSummary failed, will truncate:", msg);
          }
        }
        const spoken = selectVoiceText({
          agentVoiceMd,
          summary,
          fullReply: result.reply,
          maxChars: VOICE_TLDR_MAX_CHARS,
        });
        if (spoken) {
          try {
            const audio = await synthesizeSpeech(spoken, {
              voiceId: ALBUS_VOICE_ID!,
              outputFormat: "opus_48000_64",
            });
            writeFileSync(replyOgg, audio);
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            console.error("voice synthesis failed:", errMsg);
          }
        }
      }
```

Note: `reply.voice.md` is consumed here for synthesis. To stop `flushOutbox` from also sending it as a document attachment, delete it after reading. Add, immediately after the `agentVoiceMd = readFileSync(...)` assignment succeeds:

```ts
            try { unlinkSync(replyVoiceMd); } catch { /* best-effort */ }
```

Ensure `readFileSync` and `unlinkSync` are imported from `node:fs` at the top of `poll.ts`.

- [ ] **Step 2: Confirm `VOICE_SYNTH_MAX_CHARS` is no longer referenced**

Run: `grep -n "VOICE_SYNTH_MAX_CHARS" lib/poll.ts`
Expected: only its `export const` definition (and any test). It is no longer used in `processMessage`. Leave the export (a poll-helpers test references it) — do not delete.

- [ ] **Step 3: Gate**

Run: `bun test && bunx tsc --noEmit`
Expected: all green, zero type errors.

- [ ] **Step 4: Commit**

```bash
git add lib/poll.ts
git commit -m "feat(voice): speak a TL;DR closing clip, not a truncated read-aloud"
```

---

## Task 8: Teach Albus to write `reply.voice.md` on voice turns

**Model:** Haiku (documentation edit)

**Files:**
- Modify: `persona.md` (append to the voice-replies section, ~the block ending at the TTS CLI instructions)

- [ ] **Step 1: Add the instruction**

Append to `persona.md` right after the existing "Voice replies" block:

```markdown
**Spoken TL;DR on voice turns.** When the operator's message arrived as a voice memo (you'll see a `[voice transcript: ...]` marker), the bot will speak a short clip back. Help it: write a file `reply.voice.md` into the per-turn outbox containing a SHORT spoken TL;DR of your answer - 2 to 3 sentences, under ~30 seconds spoken, plain spoken prose (no markdown, no bullets, no headings). Your full answer still goes out as the normal text reply (or `reply.md` if long). If you skip `reply.voice.md`, the bot will auto-summarize your reply for the voice clip, so writing it just gives you control of the spoken version. Keep it in your voice, not a flat recap.
```

- [ ] **Step 2: Verify no em dashes or identity leaked into the edit**

Run: `grep -nE " — |[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+|/Users/" persona.md && echo "FIX" || echo "clean"`
Expected: `clean`.

- [ ] **Step 3: Gate + commit**

```bash
bun test && bunx tsc --noEmit
git add persona.md
git commit -m "docs(persona): write reply.voice.md spoken TL;DR on voice turns"
```

---

## Final review (Opus orchestrator, after all tasks)

- [ ] Dispatch a final code-quality reviewer (Sonnet) over the full diff `git diff b265ed9..HEAD -- lib/ persona.md persona-voice.md` (adjust base to the pre-feature SHA).
- [ ] Confirm against the spec: ack fires before the heavy turn; asides are stripped (no `--resume`/skills/MCP); persona card carries the voice; TL;DR precedence is voice.md → summary → truncate; everything voice is best-effort; gated on `isVoice` + `VOICE_ACK_ENABLED`.
- [ ] Clone-safety re-scan on committed files: `grep -rnE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+|/Users/|shawnpetros" persona.md persona-voice.md lib/` → expect no operator identity.
- [ ] Transpile/restart per the existing launchd flow; manual smoke: one long memo (weary ack + short spoken TL;DR + full text), one short question (deadpan ack), `VOICE_ACK_ENABLED=false` reverts to prior behavior.
- [ ] Use superpowers:finishing-a-development-branch.

---

## Self-review notes (author)

- **Spec coverage:** ack-first (T6), spoken TL;DR + two-artifact model (T7, T8), personality card (T5), stripped asides (T2), config/kill-switch (T1), precedence (T4), error handling best-effort (T6, T7), default-on-voice gating (T6). All spec sections map to a task.
- **Type consistency:** `spawnQuick({input,system,model})`, `buildQuickArgs({system,model})`, `quickAck(transcript)`, `voiceSummary(replyText)`, `selectVoiceText({agentVoiceMd,summary,fullReply,maxChars})`, `loadVoiceCard()` — names consistent across tasks 2/3/4/6/7.
- **No placeholders:** every code step shows full code; `ACK_INSTRUCTION`/`SUMMARY_INSTRUCTION` are functional first-pass strings replaced (not invented) in T5.
