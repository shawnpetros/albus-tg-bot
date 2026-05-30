// The bot's main loop and per-message handler. Owns the mutable per-process
// state (current session id, lock mode, offset cursor) and the serial turn
// queue, and wires together Claude, Telegram, the scratchpad, the outbox, and
// the slash router. Other modules stay pure or take dependencies; this is
// where the orchestration happens.

import { mkdirSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import {
  CHAT_ID,
  COMPACT_COOLDOWN_TURNS,
  COMPACT_TOKEN_THRESHOLD,
  DAILY_COST_FILE,
  DAILY_COST_LIMIT_USD,
  DEFAULT_MODEL,
  HEARTBEAT_FILE,
  OUTBOX_DIR,
  SESSION_FILE,
  STATE_FILE,
  TG_API,
  VOICE_ACK_ENABLED,
  VOICE_TLDR_MAX_CHARS,
} from "./config.ts";
import { writeHeartbeat } from "./heartbeat.ts";
import {
  loadSession as loadSessionFromFile,
  saveSession as saveSessionToFile,
  loadSessionRecord,
  loadState as loadStateFromFile,
  saveState as saveStateToFile,
  recordTurn,
  markCompacted,
  recordDailyCost,
  markDailyWarned,
  overDailyLimit,
  type BotState,
} from "./state.ts";
import {
  sendMessage,
  sendTyping,
  sendAttachment,
  downloadFile,
  tg,
} from "./telegram.ts";
import { flushOutbox } from "./outbox.ts";
import { createScratchpad, describeToolCall } from "./scratchpad.ts";
import { spawnAlbus, compactSession, type ToolUseCallback } from "./claude.ts";
import { handleSlashCommand } from "./slash.ts";
import { transcribeAudio, synthesizeSpeech } from "./elevenlabs.ts";
import { ELEVENLABS_API_KEY, ALBUS_VOICE_ID } from "./config.ts";
import { TurnQueue } from "./queue.ts";
import { quickAck, voiceSummary } from "./aside.ts";

// --- Pure helpers (unit-tested in test/poll-helpers.test.ts) ---

// Whether a freshly-completed turn warrants scheduling a compaction pass.
// Keys on the TRUE context fill (the last assistant message's input-side
// total), NOT the cumulative result-event usage which stacks into the millions
// and false-fired on nearly every turn.
//
// `>=` so a turn that lands exactly on the threshold still triggers. The
// cooldown is a backstop against thrashing near the boundary: if we compacted
// at `lastCompactTurn`, hold off until at least COMPACT_COOLDOWN_TURNS turns
// have elapsed (`turns` is the post-turn count). With no prior compaction
// (lastCompactTurn undefined) it's a pure threshold gate.
export function shouldCompact(
  contextTokens: number,
  turns: number,
  lastCompactTurn?: number
): boolean {
  if (contextTokens < COMPACT_TOKEN_THRESHOLD) return false;
  if (lastCompactTurn !== undefined && turns - lastCompactTurn < COMPACT_COOLDOWN_TURNS) {
    return false;
  }
  return true;
}

// Whether a turn-failure error message looks like the session is unusable and
// the turn should be retried on a fresh session. Widened beyond the original
// session/resume/jsonl set to also catch process-exit and timeout failures,
// which in practice usually mean a wedged or corrupt session.
export function looksLikeSessionLoss(errMsg: string): boolean {
  return /session|resume|jsonl|exit(ed)?|timed?\s*out|timeout/i.test(errMsg);
}

// Bounded recently-seen update_id tracker. Telegram occasionally redelivers an
// update even after we advance the offset past it (observed in prod). A small
// FIFO ring + membership Set lets us skip the dup while staying bounded: when
// the ring fills, the oldest id is evicted from both structures. Pure data
// structure, unit-tested in test/poll-helpers.test.ts.
export class SeenUpdates {
  private set = new Set<number>();
  private ring: number[] = [];
  constructor(private readonly cap: number = 200) {}

  // True if id was already recorded. Non-mutating.
  isDuplicate(id: number): boolean {
    return this.set.has(id);
  }

  // Record id as seen, evicting the oldest if at capacity. No-op on re-add.
  add(id: number): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.ring.push(id);
    if (this.ring.length > this.cap) {
      const evicted = this.ring.shift();
      if (evicted !== undefined) this.set.delete(evicted);
    }
  }

  get size(): number {
    return this.set.size;
  }
}

// Pure: getUpdates 429 backoff delay (ms). Mirrors telegram.ts's send-path
// policy: prefer Telegram's retry_after, else fall back to the flat default.
export function getUpdatesBackoffMs(retryAfterS?: number): number {
  const DEFAULT_S = 5;
  if (typeof retryAfterS === "number" && retryAfterS > 0) {
    return Math.min(retryAfterS, 60) * 1000;
  }
  return DEFAULT_S * 1000;
}

// Whether the bot should deterministically synthesize a voice reply for this
// turn. Pure so it can be unit-tested without the network or filesystem.
// True only when: the inbound turn was a voice memo, BOTH ElevenLabs env vars
// are present, AND the agent did not already drop a voice clip in the outbox
// (don't double-send). The agent convention may still write reply.mp3, while
// the bot writes reply.ogg, so the caller passes true if EITHER exists.
// Any false input short-circuits to false.
export function shouldSynthesizeVoice(
  isVoice: boolean,
  hasApiKey: boolean,
  hasVoiceId: boolean,
  replyAlreadyExists: boolean
): boolean {
  if (!isVoice) return false;
  if (!hasApiKey || !hasVoiceId) return false;
  if (replyAlreadyExists) return false;
  return true;
}

// Cap synthesized text length to bound TTS cost/latency. Long replies get
// truncated; the full text still goes out as a message.
export const VOICE_SYNTH_MAX_CHARS = 1500;

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

// A unit of work for the serial turn queue. User messages are enqueued at the
// tail; compaction is enqueueFront'd so it runs before pending messages but
// after the in-flight turn.
type QueueOp =
  | {
      kind: "message";
      userInput: string;
      messageId: number;
      turnOutbox: string;
      // True when the inbound message was a voice memo. Drives deterministic
      // voice-on-voice TTS in processMessage.
      isVoice: boolean;
    }
  | { kind: "compact"; contextTokens: number };

// Telegram payload shapes we narrow against in the per-message flow. Kept
// inline here (rather than in a shared types module) because poll.ts is the
// only consumer today.
interface TgFile {
  file_id: string;
  file_path?: string;
  mime_type?: string;
  file_name?: string;
  title?: string;
  duration?: number;
}

interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: { first_name?: string; username?: string };
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgFile;
  voice?: TgFile;
  audio?: TgFile;
  video?: TgFile;
  video_note?: TgFile;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

interface MediaAttachment {
  kind: "document" | "voice" | "audio" | "video";
  obj: TgFile;
  label: string;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface StartOptions {
  persona: string;
}

export async function startBot(opts: StartOptions): Promise<void> {
  const { persona } = opts;

  let currentSessionId: string | null = loadSessionFromFile(SESSION_FILE);
  let currentState: BotState = loadStateFromFile(STATE_FILE);
  let offset = 0;
  // Bounded dedup of inbound update_ids. Telegram has been observed to
  // redeliver an update even after offset advanced past it; we skip the dup
  // while still advancing offset as before.
  const seen = new SeenUpdates(200);

  const slashDeps = {
    getSession: () => currentSessionId,
    clearSession: () => {
      currentSessionId = null;
      saveSessionToFile(SESSION_FILE, null);
    },
    getState: () => currentState,
    setUnlocked: (next: BotState) => {
      currentState = next;
      saveStateToFile(STATE_FILE, next);
    },
    getSessionRecord: () => loadSessionRecord(SESSION_FILE),
    requestCompact: () => {
      // Manual /compact: bypass the threshold/cooldown gate entirely. Report
      // the last recorded context fill for the user-facing note.
      const rec = loadSessionRecord(SESSION_FILE);
      queue.enqueueFront({
        kind: "compact",
        contextTokens: rec?.last_prompt_tokens ?? 0,
      });
    },
    setModel: (model: string | null) => {
      const next: BotState = { ...currentState };
      if (model) next.model = model;
      else delete next.model;
      currentState = next;
      saveStateToFile(STATE_FILE, next);
    },
    sendMessage,
  };

  async function handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg) return;
    if (String(msg.chat.id) !== String(CHAT_ID)) {
      console.warn(`unauthorized chat_id=${msg.chat.id}, ignoring`);
      return;
    }

    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    const hasText = typeof msg.text === "string" && msg.text.length > 0;
    const caption = typeof msg.caption === "string" ? msg.caption : "";

    const mediaAttachment: MediaAttachment | null = (() => {
      if (msg.document) {
        return {
          kind: "document",
          obj: msg.document,
          label: msg.document.file_name || "document",
        };
      }
      if (msg.voice) {
        return { kind: "voice", obj: msg.voice, label: `voice ${msg.voice.duration ?? "?"}s` };
      }
      if (msg.audio) {
        return { kind: "audio", obj: msg.audio, label: msg.audio.title || "audio" };
      }
      if (msg.video) return { kind: "video", obj: msg.video, label: "video" };
      if (msg.video_note) {
        return { kind: "video", obj: msg.video_note, label: "video note" };
      }
      return null;
    })();

    if (!hasPhoto && !hasText && !mediaAttachment) return;

    console.log(
      `[${new Date().toISOString()}] ${msg.from?.first_name || "user"}: ` +
        (hasText
          ? (msg.text ?? "").slice(0, 80)
          : hasPhoto
          ? `[photo${caption ? " + caption: " + caption.slice(0, 60) : ""}]`
          : mediaAttachment
          ? `[${mediaAttachment.kind}: ${mediaAttachment.label}${caption ? " + caption: " + caption.slice(0, 60) : ""}]`
          : "")
    );

    if (hasText && !hasPhoto && !mediaAttachment && msg.text!.startsWith("/")) {
      if (await handleSlashCommand(msg.text!, slashDeps)) return;
    }

    let voiceTranscript = "";
    let userInput: string;
    try {
      if (hasPhoto && msg.photo) {
        const largest = msg.photo[msg.photo.length - 1];
        if (!largest) throw new Error("empty photo array");
        const localPath = await downloadFile(largest.file_id, msg.message_id, "photo");
        const captionLine = caption || (hasText ? msg.text! : "(no caption)");
        userInput = `${captionLine}\n\n[screenshot at ${localPath}]`;
      } else if (mediaAttachment) {
        const localPath = await downloadFile(
          mediaAttachment.obj.file_id,
          msg.message_id,
          mediaAttachment.kind
        );
        const mime = mediaAttachment.obj.mime_type || "unknown";
        const captionLine = caption || (hasText ? msg.text! : "(no caption)");
        // For voice memos: try to transcribe via ElevenLabs Scribe so the
        // model gets text it can reason about, while keeping the audio path
        // for cases where the transcript loses nuance. Transcription is
        // best-effort; failure falls back to path-only reference.
        let transcriptLine = "";
        if (mediaAttachment.kind === "voice" && ELEVENLABS_API_KEY) {
          try {
            const t = await transcribeAudio(localPath);
            if (t.text.trim()) {
              voiceTranscript = t.text.trim();
              transcriptLine = `\n[voice transcript: ${voiceTranscript}]`;
            }
          } catch (e) {
            const msgErr = e instanceof Error ? e.message : String(e);
            console.warn("voice transcription failed:", msgErr);
          }
        }
        userInput = `${captionLine}${transcriptLine}\n\n[${mediaAttachment.kind} at ${localPath} (mime: ${mime}, name: ${mediaAttachment.label})]`;
      } else {
        userInput = msg.text!;
      }
    } catch (e) {
      const msgErr = e instanceof Error ? e.message : String(e);
      console.error("attachment download failed:", msgErr);
      await sendMessage(`couldn't grab that attachment: ${msgErr}`, { markdown: false });
      return;
    }

    const turnOutbox = `${OUTBOX_DIR}/${msg.message_id}`;
    mkdirSync(turnOutbox, { recursive: true });

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

    // Hand the turn to the serial queue. Follow-ups fired during an in-flight
    // turn are buffered here and processed in order rather than dropped.
    queue.enqueue({
      kind: "message",
      userInput,
      messageId: msg.message_id,
      turnOutbox,
      isVoice: mediaAttachment?.kind === "voice",
    });
  }

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

  // --- Per-turn processing (one claude -p run; single-flight via the queue) ---

  async function processMessage(op: {
    userInput: string;
    turnOutbox: string;
    isVoice: boolean;
  }): Promise<void> {
    const { userInput, turnOutbox, isVoice } = op;

    const turnStartedAt = Date.now();
    await sendTyping();
    const typingTimer = setInterval(() => {
      sendTyping();
    }, 4000);

    const scratchpad = createScratchpad({ chatId: Number(CHAT_ID), send: tg });
    const onToolUse: ToolUseCallback = (name, args) => {
      scratchpad.onToolUse(describeToolCall(name, args));
    };

    // Tracks whether we already retried on a fresh session; used to surface the
    // real error (not a generic fizzle) once the retry also fails.
    let retried = false;

    try {
      let result;
      try {
        result = await spawnAlbus({
          input: userInput,
          sessionId: currentSessionId,
          unlocked: currentState.unlocked,
          onToolUse,
          outboxDir: turnOutbox,
          persona,
          model: currentState.model ?? DEFAULT_MODEL,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (currentSessionId && looksLikeSessionLoss(errMsg)) {
          console.warn(
            `session looks lost for ${currentSessionId}, retrying fresh: ${errMsg}`
          );
          currentSessionId = null;
          saveSessionToFile(SESSION_FILE, null);
          retried = true;
          // Seed the fresh session with a recovery nudge so Albus recalls
          // recent context from Honcho before answering. The persona already
          // grants Honcho access; this just points him at it.
          const recoveryPersona =
            persona +
            "\n\n(Recovering from an interrupted session, briefly recall recent context from Honcho before continuing.)";
          result = await spawnAlbus({
            input: userInput,
            sessionId: null,
            unlocked: currentState.unlocked,
            onToolUse,
            outboxDir: turnOutbox,
            persona: recoveryPersona,
            model: currentState.model ?? DEFAULT_MODEL,
          });
        } else {
          throw e;
        }
      }
      if (result.sessionId && result.sessionId !== currentSessionId) {
        currentSessionId = result.sessionId;
        saveSessionToFile(SESSION_FILE, currentSessionId);
      }
      await scratchpad.close();
      await sendMessage(result.reply || "(no reply)");

      // Deterministic voice-on-voice: if the inbound turn was a voice memo and
      // both ElevenLabs env vars are set, synthesize the text reply to speech
      // and drop it in the outbox so the flush below sends it as a voice clip.
      // Best-effort: a TTS failure logs and continues — the text reply already
      // went out. We never clobber an agent-written clip (don't double-send),
      // and the bot does the synthesis itself so this works in locked mode too.
      // We write reply.ogg (OGG/Opus) so flushOutbox/sendAttachment routes it to
      // Telegram's sendVoice (mp3 would fall through to sendDocument). The agent
      // convention may still write reply.mp3, so we skip if EITHER exists.
      const replyOgg = `${turnOutbox}/reply.ogg`;
      const replyMp3 = `${turnOutbox}/reply.mp3`;
      if (
        shouldSynthesizeVoice(
          isVoice,
          Boolean(ELEVENLABS_API_KEY),
          Boolean(ALBUS_VOICE_ID),
          existsSync(replyOgg) || existsSync(replyMp3)
        ) &&
        (result.reply || "").trim()
      ) {
        try {
          const ttsText = result.reply.slice(0, VOICE_SYNTH_MAX_CHARS);
          const audio = await synthesizeSpeech(ttsText, {
            voiceId: ALBUS_VOICE_ID!,
            outputFormat: "opus_48000_64",
          });
          writeFileSync(replyOgg, audio);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error("voice synthesis failed:", errMsg);
        }
      }

      let outboxSent = 0;
      try {
        outboxSent = await flushOutbox(turnOutbox, { sendAttachment, sendMessage });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error("flushOutbox failed:", errMsg);
      }

      // Usage accounting against the current session, then a gated compaction
      // check. last_prompt_tokens stores the TRUE context fill (contextTokens),
      // so /status shows ~59k, not the cumulative millions.
      const rec = recordTurn(SESSION_FILE, {
        promptTokens: result.contextTokens,
        costUsd: result.costUsd,
      });
      // Gate on contextTokens (the true fill: last assistant message's
      // input-side total), NOT result.promptTokens. promptTokens is cumulative
      // billed input across the whole turn — a multi-tool turn stacks cache
      // reads into the millions and would false-fire the gate every time. The
      // cooldown is a backstop against thrashing near the threshold.
      if (shouldCompact(result.contextTokens, rec.turns ?? 0, rec.last_compact_turn)) {
        // Run before pending user messages, after this in-flight turn.
        queue.enqueueFront({ kind: "compact", contextTokens: result.contextTokens });
      }

      // Per-day spend guardrail (SOFT cap). Fold this turn's cost into the
      // daily ledger (rolling over on date change), then if we've crossed the
      // limit and haven't yet warned today, post a one-time warning. We do NOT
      // refuse turns: a hard lock risks stranding the operator mid-task with no
      // way to ask the bot to unlock itself. The warning is the signal; acting
      // on it is the operator's call.
      try {
        const daily = recordDailyCost(DAILY_COST_FILE, result.costUsd);
        if (overDailyLimit(daily, DAILY_COST_LIMIT_USD) && !daily.warned) {
          markDailyWarned(DAILY_COST_FILE);
          await sendMessage(
            `⚠️ daily spend $${daily.cost_usd.toFixed(2)} over the $${DAILY_COST_LIMIT_USD.toFixed(2)} cap. Carrying on, but keep an eye on it.`,
            { markdown: false }
          );
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error("daily-cost guardrail failed:", errMsg);
      }

      const elapsedS = ((Date.now() - turnStartedAt) / 1000).toFixed(1);
      console.log(
        `  -> sent ${result.reply.length} chars, session=${result.sessionId?.slice(
          0,
          8
        )}, ` +
          `turns=${result.turns}, cost=$${result.cost.toFixed(4)}, ` +
          `context_tokens=${result.contextTokens}, prompt_tokens(cumulative)=${result.promptTokens}, ` +
          `mode=${currentState.unlocked ? "unlocked" : "locked"}, ` +
          `tools=${scratchpad.toolCount()}, attachments=${outboxSent}, elapsed=${elapsedS}s`
      );
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("turn failed:", errMsg);
      // Surface the REAL error. If we already retried on a fresh session and
      // still failed, say so and include the actual message — don't swallow it
      // behind a generic fizzle.
      const detail = retried
        ? `💥 the spell fizzled and the retry too — ${errMsg}`
        : `💥 the spell fizzled — ${errMsg}`;
      if (scratchpad.toolCount() > 0) {
        await scratchpad.error(detail);
      } else {
        await sendMessage(detail, { markdown: false });
      }
    } finally {
      clearInterval(typingTimer);
    }
  }

  // --- Compaction op: headless /compact on the current session ---

  async function processCompact(op: { contextTokens: number }): Promise<void> {
    if (!currentSessionId) {
      // Nothing to compact (session rotated out from under us). No-op.
      return;
    }
    const approxK = Math.round(op.contextTokens / 1000);
    await sendMessage(
      `📊 trimming context (~${approxK}k tokens) to stay sharp…`,
      { markdown: false }
    );
    let ok = false;
    try {
      ok = await compactSession(currentSessionId);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("compaction threw:", errMsg);
      ok = false;
    }
    if (ok) {
      // Compaction keeps the same session_id, so no session-file change.
      // Stamp the cooldown point so we don't re-compact for the next
      // COMPACT_COOLDOWN_TURNS turns.
      markCompacted(SESSION_FILE);
      console.log(`  -> compacted session=${currentSessionId.slice(0, 8)}`);
      await sendMessage("✅ done.", { markdown: false });
    } else {
      console.warn("compaction failed; continuing on existing session");
      await sendMessage(
        "compaction didn't take — carrying on as-is.",
        { markdown: false }
      );
    }
  }

  // Single-flight serial queue: never two claude processes against one session
  // at once. One bad item logs and the queue keeps draining.
  const queue = new TurnQueue<QueueOp>(
    async (op) => {
      if (op.kind === "message") {
        await processMessage(op);
      } else {
        await processCompact(op);
      }
    },
    {
      onError: (err, op) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`queue item (${op.kind}) errored:`, errMsg);
      },
    }
  );

  console.log(
    `albus-tg-bot started, watching chat_id=${CHAT_ID}, ` +
      `session=${
        currentSessionId
          ? currentSessionId.slice(0, 8) + "..."
          : "(none, will start fresh on first message)"
      }, ` +
      `mode=${currentState.unlocked ? "UNLOCKED" : "LOCKED"}`
  );

  // Stamp once at startup so the watchdog doesn't trip in the gap between
  // launchd starting us and the first poll completing.
  writeHeartbeat(HEARTBEAT_FILE);

  while (true) {
    try {
      const url = `${TG_API}/getUpdates?timeout=30&offset=${offset}`;
      const res = await fetch(url);
      const data = (await res.json()) as TgResponse<TgUpdate[]>;
      // Heartbeat AFTER a successful getUpdates round-trip; this means a
      // deadlocked socket eventually stales out instead of refreshing forever.
      writeHeartbeat(HEARTBEAT_FILE);
      if (!data.ok) {
        // On 429, honor Telegram's retry_after (capped) instead of the flat
        // 5s so we back off correctly under rate limiting.
        if (data.error_code === 429) {
          const waitMs = getUpdatesBackoffMs(data.parameters?.retry_after);
          console.warn(`getUpdates 429 rate-limited, waiting ${waitMs}ms`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        console.error("getUpdates error:", data.description);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const update of data.result ?? []) {
        // Always advance offset, even for dups, so we don't refetch them.
        offset = update.update_id + 1;
        if (seen.isDuplicate(update.update_id)) {
          console.warn(`skipping duplicate update_id=${update.update_id}`);
          continue;
        }
        seen.add(update.update_id);
        await handleUpdate(update);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("poll error:", errMsg);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
