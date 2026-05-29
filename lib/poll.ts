// The bot's main loop and per-message handler. Owns the mutable per-process
// state (current session id, lock mode, offset cursor) and the serial turn
// queue, and wires together Claude, Telegram, the scratchpad, the outbox, and
// the slash router. Other modules stay pure or take dependencies; this is
// where the orchestration happens.

import { mkdirSync } from "node:fs";
import {
  CHAT_ID,
  COMPACT_TOKEN_THRESHOLD,
  DEFAULT_MODEL,
  HEARTBEAT_FILE,
  OUTBOX_DIR,
  SESSION_FILE,
  STATE_FILE,
  TG_API,
} from "./config.ts";
import { writeHeartbeat } from "./heartbeat.ts";
import {
  loadSession as loadSessionFromFile,
  saveSession as saveSessionToFile,
  loadSessionRecord,
  loadState as loadStateFromFile,
  saveState as saveStateToFile,
  recordTurn,
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
import { transcribeAudio } from "./elevenlabs.ts";
import { ELEVENLABS_API_KEY } from "./config.ts";
import { TurnQueue } from "./queue.ts";

// --- Pure helpers (unit-tested in test/poll-helpers.test.ts) ---

// Whether a freshly-completed turn's prompt-token count warrants scheduling a
// compaction pass. `>=` so a turn that lands exactly on the threshold still
// triggers.
export function shouldCompact(promptTokens: number): boolean {
  return promptTokens >= COMPACT_TOKEN_THRESHOLD;
}

// Whether a turn-failure error message looks like the session is unusable and
// the turn should be retried on a fresh session. Widened beyond the original
// session/resume/jsonl set to also catch process-exit and timeout failures,
// which in practice usually mean a wedged or corrupt session.
export function looksLikeSessionLoss(errMsg: string): boolean {
  return /session|resume|jsonl|exit(ed)?|timed?\s*out|timeout/i.test(errMsg);
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
    }
  | { kind: "compact"; promptTokens: number };

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
}

export interface StartOptions {
  persona: string;
}

export async function startBot(opts: StartOptions): Promise<void> {
  const { persona } = opts;

  let currentSessionId: string | null = loadSessionFromFile(SESSION_FILE);
  let currentState: BotState = loadStateFromFile(STATE_FILE);
  let offset = 0;

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
      const rec = loadSessionRecord(SESSION_FILE);
      queue.enqueueFront({
        kind: "compact",
        promptTokens: rec?.last_prompt_tokens ?? 0,
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
              transcriptLine = `\n[voice transcript: ${t.text.trim()}]`;
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

    // Hand the turn to the serial queue. Follow-ups fired during an in-flight
    // turn are buffered here and processed in order rather than dropped.
    queue.enqueue({
      kind: "message",
      userInput,
      messageId: msg.message_id,
      turnOutbox,
    });
  }

  // --- Per-turn processing (one claude -p run; single-flight via the queue) ---

  async function processMessage(op: {
    userInput: string;
    turnOutbox: string;
  }): Promise<void> {
    const { userInput, turnOutbox } = op;

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
      let outboxSent = 0;
      try {
        outboxSent = await flushOutbox(turnOutbox, { sendAttachment, sendMessage });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error("flushOutbox failed:", errMsg);
      }

      // Usage accounting against the current session, then a compaction check.
      recordTurn(SESSION_FILE, {
        promptTokens: result.promptTokens,
        costUsd: result.costUsd,
      });
      // Gate on RESIDENT size, not promptTokens. promptTokens is cumulative
      // billed input across the whole turn — a multi-tool turn stacks cache
      // reads into the millions and would trip the gate every time. residentTokens
      // is one round-trip's view of the thread, which is what we actually want
      // to keep under the context ceiling.
      if (shouldCompact(result.residentTokens)) {
        // Run before pending user messages, after this in-flight turn.
        queue.enqueueFront({ kind: "compact", promptTokens: result.residentTokens });
      }

      const elapsedS = ((Date.now() - turnStartedAt) / 1000).toFixed(1);
      console.log(
        `  -> sent ${result.reply.length} chars, session=${result.sessionId?.slice(
          0,
          8
        )}, ` +
          `turns=${result.turns}, cost=$${result.cost.toFixed(4)}, ` +
          `prompt_tokens=${result.promptTokens}, resident=${result.residentTokens}, ` +
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

  async function processCompact(op: { promptTokens: number }): Promise<void> {
    if (!currentSessionId) {
      // Nothing to compact (session rotated out from under us). No-op.
      return;
    }
    const approxK = Math.round(op.promptTokens / 1000);
    await sendMessage(
      `📊 context at ~${approxK}k tokens — compacting so I stay sharp…`,
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
      console.log(`  -> compacted session=${currentSessionId.slice(0, 8)}`);
      await sendMessage("✅ compacted, carrying on.", { markdown: false });
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
        console.error("getUpdates error:", data.description);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const update of data.result ?? []) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("poll error:", errMsg);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
