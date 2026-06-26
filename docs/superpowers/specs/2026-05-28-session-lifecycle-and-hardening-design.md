# Session lifecycle, usage tracking, and clone-safety hardening

**Date:** 2026-05-28
**Status:** Approved design — pre-implementation

## Problem

The bot spawns `claude -p --resume <sid>` per Telegram turn. It was pinned to a single session that grew to ~6.8 MB / 2,830 lines and **never compacted** — headless `--resume` does not auto-compact, so every turn replayed the entire history. Result: turns timed out, and the oversized replay intermittently failed with `claude exited 1` (no stderr; in stream-json the error rides on stdout). The retry guard only matches `/session|resume|jsonl/`, so neither a timeout nor an `exited 1` triggers the fresh-session fallback — failures surface to Telegram as "💥 spell fizzled".

Two adjacent issues compound it:
- The bot's MCP config points at a **defunct memory server** (`openmemory`), so it has no live durable memory — which is *why* the one session was allowed to grow unbounded: the session had become the memory.
- A **clone-safety refactor** (config externalization to a user-config dir, persona base + local overlay, `.example` launchd files) is complete on disk but **uncommitted**, with a staging gap that would delete the launchd files if committed as-is.

## Goals

1. Prevent session bloat; keep turns fast.
2. Preserve continuity across compaction so the user never re-explains.
3. Track token/cost usage per session — forward-looking, since from 2026-06-15 headless `claude -p` usage draws from a separate Agent SDK credit pool.
4. Finish the clone-safety refactor without leaking operator config.
5. Self-heal on session failure instead of fizzling.

**Non-goals (v1):** mid-turn steering/interrupt (the SDK is serial by design), direct Messages-API compaction, any coupling to the larger gateway project.

## Established facts (verified)

- `claude -p "/compact" --resume <id>` triggers compaction headlessly; continuity is preserved; `session_id` is unchanged.
- The stream-json `result` event carries `usage` (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`) and `modelUsage[model]` (`costUSD`, `contextWindow`, `maxOutputTokens`). Undocumented but present; the TS SDK `SDKResultMessage.usage` is the documented fallback if the field shape shifts.
- Claude Code's own auto-compaction default is ~150k input tokens. We trigger earlier (120k) to control timing and keep turns responsive.
- Mid-turn steering is unsupported; a serialized queue is the intended pattern.
- Two concurrent processes against one session id is unsafe → one session per bot, single-flight.
- `--setting-sources project,local` is retained deliberately: inheriting user-scope settings would drag the operator's hooks, permissions, and MCP servers into every bot turn and break clone-safety. Memory is therefore wired **explicitly** via `resolveMcpConfig()`, not inherited.

## Workstreams

### WS0 — Unblock (immediate)
Back up and reset the persisted session record (`session_id: null`); restart the service. The bot resumes on a fresh session.

### WS1 — Finish the clone-safety refactor
- `git add` the `.example` launchd files. **Critical:** committing without this deletes the real launchd files from the index and ships zero examples.
- Generalize the launchd `.gitignore` pattern so a cloner's rendered host files are ignored while the `.example` files are tracked.
- Complete the memory-server swap in code — tool allowlist (`config.ts` `LOCKED_ALLOWED_TOOLS`), the locked/unlocked mode prompts, slash-command text (`slash.ts`), the `bot.ts` comment, and the example MCP config — replacing the defunct server with the memory MCP the bot now targets.
- Typecheck, commit, push, restart.

### WS2 — Session lifecycle (new)

Components, by file:

- **`lib/queue.ts` (new) — TurnQueue.** Single-consumer FIFO. Items are either inbound user messages or system ops (compaction). One worker drains serially; replaces the bare `busy` flag in `poll.ts`. Telegram messages that arrive mid-turn are enqueued (steer-buffering) and drained in order.
- **`lib/claude.ts` — usage parsing.** Extend the stream-json consumer to capture the `result` event's `usage` + `modelUsage`. Add to `ClaudeTurnResult`: `promptTokens` (= `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`), `contextWindow`, `costUsd`.
- **`lib/state.ts` — session accounting.** Persist per-session cumulative `tokens`, `cost`, `turns`, `created_at`, and last-observed `promptTokens`.
- **`lib/poll.ts` — compaction trigger.** After each turn, if `promptTokens >= COMPACT_TOKEN_THRESHOLD`, enqueue a compaction op ahead of pending user messages. The op runs `claude -p "/compact" --resume <sid>`, posts a Telegram status ("📊 context at Nk, compacting…" → "✅ done, carrying on"), then the worker continues draining. Continue-after-compaction falls out of the queue model for free.
- **`lib/poll.ts` — recovery guard.** Widen the fallback predicate to also match `/exit|exited|timed?\s*out|timeout/i`. On hard failure: reset session to null, start a fresh session seeded with a memory recall block in the system prompt, retry once. If retry fails, post the **real** error to Telegram (not "fizzled"). Never spawn a second `claude` against a live session (the queue guarantees single-flight).
- **`lib/slash.ts` — surface.** Status command shows session turns / tokens / cost / age; add a `/compact` command that enqueues a manual compaction.

Config (`lib/config.ts`): `COMPACT_TOKEN_THRESHOLD = 120_000` (configurable via env); keep `TURN_TIMEOUT_MS`.

## Data flow

```
TG message
  → enqueue
  → worker: spawn claude -p (resume or fresh) → parse stream
  → on result: record usage → send reply + flush outbox
  → if promptTokens ≥ threshold: enqueue compaction op
  → worker drains compaction (claude -p "/compact") → TG status → continue draining
```

## Error handling

- **Turn throws** (timeout / exited / API error): widened guard → if session-related, exit, or timeout, clear session and retry once on a fresh session (seeded by memory recall). If the retry also fails, post the real error to Telegram.
- **Compaction op fails:** log, post a brief Telegram note, continue on the existing session. Compaction failure is non-fatal; the next threshold crossing retries. (Note: an already-poisoned session may fail to compact because compaction resumes from disk; in that case the recovery guard's fresh-session path takes over.)
- **Single-flight invariant:** never two concurrent `claude` processes on one session id.

## Testing

- **Unit:** TurnQueue ordering/serialization (enqueue during in-flight, compaction-ahead-of-messages), usage parsing from a captured `result` event, threshold logic, widened guard regex. The repo already uses a vitest-style harness (`test/state.test.ts`, `outbox`, `format`, `heartbeat`, `smoke`).
- **Integration/manual:** with a lowered threshold in a test env, drive a session past it; confirm auto-compaction fires, the Telegram status posts, continuity holds (plant a fact, verify it survives), and the queue drains pending messages afterward.

## Rollout

`bot.mjs` is the launchd production target, built from `bot.ts`. Transpile after changes and restart via launchd; the watchdog plist already exists.
