// The bot's main loop and per-message handler. Owns the mutable per-process
// state (current session id, lock mode, busy flag, offset cursor) and wires
// together Claude, Telegram, the scratchpad, the outbox, and the slash
// router. Other modules stay pure or take dependencies; this is where the
// orchestration happens.

import { mkdirSync } from "node:fs";
import {
  CHAT_ID,
  OUTBOX_DIR,
  SESSION_FILE,
  STATE_FILE,
  TG_API,
} from "./config.ts";
import {
  loadSession as loadSessionFromFile,
  saveSession as saveSessionToFile,
  loadState as loadStateFromFile,
  saveState as saveStateToFile,
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
import { spawnAlbus, type ToolUseCallback } from "./claude.ts";
import { handleSlashCommand } from "./slash.ts";

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
  let busy = false;
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
        userInput = `${captionLine}\n\n[${mediaAttachment.kind} at ${localPath} (mime: ${mime}, name: ${mediaAttachment.label})]`;
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

    if (busy) {
      await sendMessage(
        "still working on the previous turn, queue this and try again in a moment"
      );
      return;
    }
    busy = true;

    const turnStartedAt = Date.now();
    await sendTyping();
    const typingTimer = setInterval(() => {
      sendTyping();
    }, 4000);

    const scratchpad = createScratchpad({ chatId: Number(CHAT_ID), send: tg });
    const onToolUse: ToolUseCallback = (name, args) => {
      scratchpad.onToolUse(describeToolCall(name, args));
    };

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
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const looksLikeSessionLoss =
          currentSessionId && /session|resume|jsonl/i.test(errMsg);
        if (looksLikeSessionLoss) {
          console.warn(
            `resume failed for ${currentSessionId}, starting fresh: ${errMsg}`
          );
          currentSessionId = null;
          saveSessionToFile(SESSION_FILE, null);
          result = await spawnAlbus({
            input: userInput,
            sessionId: null,
            unlocked: currentState.unlocked,
            onToolUse,
            outboxDir: turnOutbox,
            persona,
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
      const elapsedS = ((Date.now() - turnStartedAt) / 1000).toFixed(1);
      console.log(
        `  -> sent ${result.reply.length} chars, session=${result.sessionId?.slice(
          0,
          8
        )}, ` +
          `turns=${result.turns}, cost=$${result.cost.toFixed(4)}, ` +
          `mode=${currentState.unlocked ? "unlocked" : "locked"}, ` +
          `tools=${scratchpad.toolCount()}, attachments=${outboxSent}, elapsed=${elapsedS}s`
      );
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("turn failed:", errMsg);
      if (scratchpad.toolCount() > 0) {
        await scratchpad.error(`💥 spell fizzled: ${errMsg.slice(0, 200)}`);
      } else {
        await sendMessage(`bot error: ${errMsg}`);
      }
    } finally {
      clearInterval(typingTimer);
      busy = false;
    }
  }

  console.log(
    `albus-tg-bot started, watching chat_id=${CHAT_ID}, ` +
      `session=${
        currentSessionId
          ? currentSessionId.slice(0, 8) + "..."
          : "(none, will start fresh on first message)"
      }, ` +
      `mode=${currentState.unlocked ? "UNLOCKED" : "LOCKED"}`
  );

  while (true) {
    try {
      const url = `${TG_API}/getUpdates?timeout=30&offset=${offset}`;
      const res = await fetch(url);
      const data = (await res.json()) as TgResponse<TgUpdate[]>;
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
