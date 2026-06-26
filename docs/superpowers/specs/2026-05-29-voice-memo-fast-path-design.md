# Voice memo fast-path: ack-first, work-queued, spoken TL;DR

**Date:** 2026-05-29
**Status:** Approved design - pre-implementation

## Problem

A voice memo today blocks on the full agentic pass before the operator hears
anything back. The flow is: download, transcribe (ElevenLabs Scribe), inline
the transcript, enqueue, run the heavy `claude -p` pass (20-60s), send the text
reply, then synthesize a flat 1500-char truncation of that reply as the voice
clip. Two problems:

1. **No fast feedback.** The operator sends a memo and waits the full turn with
   no signal the bot heard them.
2. **The voice clip is a dumb read-aloud.** Truncating the full reply to 1500
   chars and speaking it verbatim is not how anyone wants to consume a long
   answer by ear.

## Goals

1. Speak an immediate, in-character acknowledgement the moment a voice memo
   lands, before the heavy pass runs.
2. Replace the truncated read-aloud with a real spoken TL;DR (<= ~30s), with
   the full answer available as text underneath.
3. Keep personality in both asides. The acknowledgement should land a dry,
   Friday/Jarvis-style quip, not a generic "processing."
4. Make this the default for any voice-in turn, with a kill switch.

**Non-goals (v1):** changing the heavy pass at all; mid-turn steering; voice
asides on text-in turns; a raw Anthropic API client (we keep shelling to
`claude -p`).

## Established facts (verified)

- Voice-in already transcribes via `transcribeAudio` in `lib/poll.ts`
  (`handleUpdate`), inlines `[voice transcript: ...]`, and enqueues with
  `isVoice: true`.
- Voice-out today synthesizes `result.reply.slice(0, 1500)` to `reply.ogg`
  (OGG/Opus) and `flushOutbox` routes `.ogg` to `sendVoice`. Skipped if the
  agent already wrote `reply.ogg`/`reply.mp3` (no double-send).
- `spawnAlbus` (lib/claude.ts) builds `claude` args: persona via
  `--append-system-prompt`, `--setting-sources project,local`, `--mcp-config`,
  optional `--model`, optional `--resume <sid>`, mode-gated tool flags.
- **Latency source.** The seconds in a turn come from MCP server spawn, skills
  discovery, and session replay (`--resume`), NOT from the system prompt. A
  small system prompt is effectively free. Therefore a fast aside keeps a rich
  persona but drops `--resume`, empties `--setting-sources`, and passes
  `--mcp-config '{}'`. Expected aside latency ~2-3s (process floor + short
  generation).
- The asides are sessionless and toolless, so they never touch the main
  session id. The single-flight invariant on the real session is untouched.

## The two-artifact model

On a voice turn the heavy pass produces two artifacts, the spoken twin of the
existing "long answer -> TL;DR + `reply.md` attachment" text rule:

1. **Spoken TL;DR** (`reply.voice.md`) - the lead. <= ~30s spoken, ~2-3
   sentences, plain spoken prose. This is what gets voiced back.
2. **Full reply** - the text artifact, as always. If long, it already becomes
   the `reply.md` attachment via the existing length gate.

Going deep stays a read. The listen is always the short version.

## Components by file

### `lib/claude.ts` - `spawnQuick`
New primitive: a bare, fast `claude -p` call.

```
spawnQuick({ input, system, model }): Promise<string>
```
- Args: `--append-system-prompt <system>`, `--model <model>` (default the
  configured aside model), `--output-format json`, empty `--setting-sources`,
  `--mcp-config '{}'`. No `--resume`, no outbox, no mode tool flags.
- Returns the reply text. Carries the same timeout/SIGKILL guard pattern as
  `spawnAlbus`/`compactSession`. Throws on failure (callers treat as
  best-effort).

### `lib/aside.ts` (new)
Owns the two aside prompts. Pure prompt-builders over `spawnQuick` so they can
be unit-tested with a mocked spawner.

- `quickAck(transcript): Promise<string>` - one spoken line, in character.
  Prompt instructs: react to the *shape and ambition* of the ask (long-winded
  build-out earns a weary quip; a one-line question earns a deadpan beat).
  Explicitly forbidden from attempting anything needing tools or memory. Do not
  summarize the request back. Do not say "I'll get started."
- `voiceSummary(replyText): Promise<string>` - the Haiku fallback spoken TL;DR
  when the agent skipped `reply.voice.md`. Condenses to <= `VOICE_TLDR_MAX_CHARS`,
  in Albus's voice, faithful to the full reply.

Both pass the voice card (below) as `system`.

### `persona-voice.md` (new) - the voice card
A ~400-token personality slice, NOT the full persona. Hand-authored, not
extracted, because the full persona's capability/formatting sections dilute the
few-shot. Contents:
- Who Albus is in two breaths (dry, senior, lightly amused; the existing
  register).
- **5-6 exemplar quips** in the target register (the seed line: "here we go
  again... shall I clear your evening?"). Exemplars carry the voice; adjectives
  do not.
- Hard rails: one line; react, don't recap; dry, never zany; no
  exclamation-mark hype; no emoji; the em-dash ban still applies.

### `lib/poll.ts`
- **`handleUpdate`**, after transcription and before `enqueue`: if the turn is
  voice and `VOICE_ACK_ENABLED`, call `quickAck(transcript)`, synthesize OGG,
  `sendVoice`. Wrapped best-effort: any failure logs and is dropped; the heavy
  turn enqueues regardless. The ack never blocks or gates the real work.
- **`processMessage`**, replace the 1500-char truncation with a precedence
  selector for the closing voice clip:
  1. agent wrote audio (`reply.ogg`/`reply.mp3`) -> send as-is (existing).
  2. agent wrote `reply.voice.md` -> synthesize that text.
  3. else `voiceSummary(result.reply)` -> synthesize.
  4. else truncate `result.reply` to `VOICE_TLDR_MAX_CHARS` (last-resort
     fallback if the summary call also fails).
  Extracted as a pure function `selectVoiceText({ hasAgentAudio, voiceMd,
  summary, fullReply })` for testing; synthesis stays in `processMessage`.

### `persona.md`
Add: on a voice turn (the prompt carries the `[voice transcript: ...]` marker),
always also write `reply.voice.md` - a short spoken TL;DR, <= ~30s, plain spoken
prose. The full reply stays the text artifact / `reply.md`.

### `lib/config.ts`
- `VOICE_ACK_ENABLED` (default `true`) - kill switch for the fast-path.
- `VOICE_ASIDE_MODEL` (default `claude-haiku-4-5`) - fixed fast model for both
  asides, independent of the session's `/model` setting.
- `VOICE_TLDR_MAX_CHARS` (default ~600) - spoken TL;DR cap; replaces the 1500
  truncation for the summary path.

## Data flow

```
voice memo in
  -> download + transcribe (exists)
  -> if VOICE_ACK_ENABLED: quickAck(transcript) -> synth OGG -> sendVoice   [best-effort, before enqueue]
  -> enqueue heavy turn (exists, unchanged)
  -> heavy claude -p pass (exists) -> full text reply + maybe reply.voice.md
  -> sendMessage(full reply)
  -> selectVoiceText: agent audio | reply.voice.md | voiceSummary | truncate
  -> synth -> flushOutbox -> sendVoice
```

## Error handling

Every voice artifact is best-effort; the text reply is always the source of
truth and always sends.
- Ack model call fails -> log, skip the ack, proceed to enqueue.
- Ack TTS fails -> log, skip.
- `voiceSummary` fails -> truncation fallback (status quo behavior).
- An aside throwing must never propagate into the heavy turn.

## Testing

- **Unit:** `quickAck`/`voiceSummary` prompt assembly with a mocked
  `spawnQuick`; `selectVoiceText` precedence over which artifacts exist;
  ack best-effort failure path (mock a throwing `spawnQuick`, assert the turn
  still enqueues).
- **Manual:** send a long-winded build-out memo; confirm a fast in-character
  ack voice lands within a few seconds, the heavy turn runs, and a short spoken
  TL;DR plus full text follow. Send a one-line question; confirm a deadpan ack.
  Toggle `VOICE_ACK_ENABLED=false`; confirm the path reverts to today's
  behavior. Tune `persona-voice.md` exemplars against real memos.

## Rollout

Transpile per the existing build, restart via launchd. The voice card is tuned
post-ship against real memos rather than guessed blind.

## Open risks

- **Forced whimsy.** Personality prompting degrades into cringe. Mitigation:
  exemplar-driven voice card + banned-tone rails + post-ship tuning. This is
  the one section to revisit if the acks land wrong.
- **Overlapping acks.** A second memo sent during an in-flight turn gets its ack
  while the prior reply is still cooking. The ack names the new memo so it reads
  fine; accepted, not gated.
- **Aside cost.** Adds two Haiku calls and one extra TTS per voice turn. Trivial
  for personal use; the existing daily-cost guardrail still applies.
