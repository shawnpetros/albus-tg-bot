#!/usr/bin/env bun
// albus-tg-bot - Telegram surface for Albus.
// Long-polls Telegram getUpdates, spawns `claude -p` per message with
// OpenMemory MCP access and the Albus persona, sends the response back.
//
// Session-continuous: captures `session_id` from each `claude -p --output-format
// stream-json` response, persists it to ~/.albus-tg-bot/session.json, and
// passes --resume on subsequent calls so Claude itself remembers the
// conversation. Mem0 still serves as the long-term cross-session substrate;
// the session_id is the short-term thread-of-thought.
//
// Authorized for a single chat_id (env: ALBUS_BOT_CHAT_ID).
// Slash commands: /reset (start a fresh session), /session (show current id),
//   /unlock, /lock, /relock, /help.

import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createInterface } from "node:readline";

import { formatForTelegram } from "./lib/format.ts";
import {
  TOKEN,
  CHAT_ID,
  PERSONA_PATH,
  MCP_CONFIG,
  TG_API,
  TURN_TIMEOUT_MS,
  TG_MSG_MAX,
  STATE_DIR,
  SESSION_FILE,
  STATE_FILE,
  PHOTOS_DIR,
  OUTBOX_DIR,
  LOCKED_ALLOWED_TOOLS,
  LOCKED_MODE_PROMPT,
  UNLOCKED_MODE_PROMPT,
} from "./lib/config.ts";
import {
  loadSession as loadSessionFromFile,
  saveSession as saveSessionToFile,
  loadState as loadStateFromFile,
  saveState as saveStateToFile,
  type BotState,
} from "./lib/state.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface TgResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface ClaudeTurnResult {
  reply: string;
  sessionId: string | null;
  cost: number;
  turns: number;
}

type ToolUseCallback = (name: string, args: Record<string, unknown>) => void;

interface MediaAttachment {
  kind: "document" | "voice" | "audio" | "video";
  obj: TgFile;
  label: string;
}

// Config + state paths come from ./lib/config.ts. Persona body is loaded once
// here because it's small and the file path is stable.
const PERSONA = readFileSync(PERSONA_PATH, "utf8");

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(PHOTOS_DIR, { recursive: true });
mkdirSync(OUTBOX_DIR, { recursive: true });

let offset = 0;
let busy = false;

// ---------------------------------------------------------------------------
// Session + state persistence (lib/state.ts wraps file I/O; we bind file paths)
// ---------------------------------------------------------------------------

const loadSession = (): string | null => loadSessionFromFile(SESSION_FILE);
const saveSession = (id: string | null): void => saveSessionToFile(SESSION_FILE, id);
const loadState = (): BotState => loadStateFromFile(STATE_FILE);
const saveState = (state: BotState): void => saveStateToFile(STATE_FILE, state);

let currentSessionId: string | null = loadSession();
let currentState: BotState = loadState();

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

async function tg<T = unknown>(method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${TG_API}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as TgResponse<T>;
  if (!data.ok) throw new Error(`tg ${method}: ${data.description || "unknown error"}`);
  return data.result as T;
}

async function sendMessage(
  text: string,
  { markdown = true }: { markdown?: boolean } = {}
): Promise<void> {
  if (!text) text = "(empty response)";
  for (let i = 0; i < text.length; i += TG_MSG_MAX) {
    const chunk = text.slice(i, i + TG_MSG_MAX);
    const payload = markdown ? formatForTelegram(chunk) : chunk;
    const body = markdown
      ? { chat_id: Number(CHAT_ID), text: payload, parse_mode: "HTML" }
      : { chat_id: Number(CHAT_ID), text: payload };
    try {
      await tg("sendMessage", body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (markdown && /can't parse|parse_mode|entities/i.test(msg)) {
        console.warn("HTML parse failed, sending plain:", msg);
        await tg("sendMessage", { chat_id: Number(CHAT_ID), text: chunk });
      } else {
        throw e;
      }
    }
  }
}

async function sendAttachment(filePath: string, caption?: string): Promise<unknown> {
  if (!existsSync(filePath)) throw new Error(`attachment missing: ${filePath}`);
  const buf = readFileSync(filePath);
  const fname = filePath.split("/").pop() || "file";
  const lowExt = (fname.split(".").pop() || "").toLowerCase();
  let method = "sendDocument";
  let fieldName = "document";
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(lowExt)) {
    method = "sendPhoto";
    fieldName = "photo";
  } else if (["ogg", "oga", "opus"].includes(lowExt)) {
    method = "sendVoice";
    fieldName = "voice";
  }
  const form = new FormData();
  form.append("chat_id", String(CHAT_ID));
  form.append(fieldName, new Blob([buf]), fname);
  if (caption) form.append("caption", caption);
  const res = await fetch(`${TG_API}/${method}`, { method: "POST", body: form });
  const data = (await res.json()) as TgResponse;
  if (!data.ok) throw new Error(`${method}: ${data.description || "unknown error"}`);
  return data.result;
}

async function flushOutbox(turnDir: string): Promise<number> {
  if (!existsSync(turnDir)) return 0;
  let sent = 0;
  for (const name of readdirSync(turnDir)) {
    if (name.startsWith(".") || name.endsWith(".caption.txt")) continue;
    const full = `${turnDir}/${name}`;
    const captionPath = `${full}.caption.txt`;
    const caption = existsSync(captionPath)
      ? readFileSync(captionPath, "utf8").trim()
      : undefined;
    try {
      await sendAttachment(full, caption);
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`outbox send failed for ${name}: ${msg}`);
      await sendMessage(`couldn't send attachment ${name}: ${msg}`, { markdown: false });
    }
  }
  try {
    rmSync(turnDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  return sent;
}

async function sendTyping(): Promise<void> {
  try {
    await tg("sendChatAction", { chat_id: Number(CHAT_ID), action: "typing" });
  } catch {
    /* typing indicator is non-critical */
  }
}

async function downloadFile(
  fileId: string,
  msgId: number,
  kind: string = "photo"
): Promise<string> {
  const meta = await tg<TgFile>("getFile", { file_id: fileId });
  if (!meta?.file_path) {
    throw new Error(`getFile returned no file_path for ${fileId}`);
  }
  const ext = meta.file_path.includes(".") ? meta.file_path.split(".").pop() : "bin";
  const safeKind = kind.replace(/[^a-z0-9]/gi, "");
  const localPath = `${PHOTOS_DIR}/${msgId}-${safeKind}-${fileId.slice(-10)}.${ext}`;
  const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${meta.file_path}`;
  const res = await fetch(fileUrl);
  if (!res.ok) {
    throw new Error(`telegram file download ${res.status}: ${meta.file_path}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(localPath, buf);
  return localPath;
}

// ---------------------------------------------------------------------------
// Claude subprocess
// ---------------------------------------------------------------------------

function describeToolCall(name: string, args: Record<string, unknown>): string {
  const basename = (p: unknown): string =>
    typeof p === "string" && p ? p.split("/").pop() || "" : "";
  const clip = (s: unknown, n = 60): string =>
    typeof s === "string" ? s.slice(0, n) : "";
  switch (name) {
    case "Bash":
      return `🧪 brewing: ${clip(args.description ?? args.command)}`;
    case "Edit":
      return `✍️ inscribing ${basename(args.file_path)}`;
    case "Write":
      return `📜 scribing ${basename(args.file_path)}`;
    case "Read":
      return `📖 perusing ${basename(args.file_path)}`;
    case "Grep":
      return `🔍 scrying for "${clip(args.pattern)}"`;
    case "Glob":
      return `🗺️ surveying "${clip(args.pattern)}"`;
    case "WebFetch": {
      let host = "";
      try {
        host = new URL(String(args.url)).host;
      } catch {
        /* invalid URL; show no host */
      }
      return host ? `🦉 dispatching an owl to ${host}` : "🦉 dispatching an owl";
    }
    case "WebSearch":
      return `🔮 consulting the seeing-glass: "${clip(args.query)}"`;
    case "Task":
      return `🪄 summoning: ${clip(args.description)}`;
    case "TodoWrite":
      return `📋 charting ${Array.isArray(args.todos) ? args.todos.length : 0} todos`;
    default:
      if (name.startsWith("mcp__")) {
        const frag = name.replace(/^mcp__/, "").replace(/__/g, " ");
        if (/add|save|write|create|set|update|delete/i.test(name)) {
          return `💾 committing: ${frag}`;
        }
        return `🔭 inquiring: ${frag}`;
      }
      return `⚙️ casting ${name}`;
  }
}

function spawnAlbus(
  input: string,
  sessionId: string | null,
  unlocked: boolean,
  onToolUse: ToolUseCallback | null,
  outboxDir: string
): Promise<ClaudeTurnResult> {
  return new Promise((resolveP, rejectP) => {
    const outboxBlock = outboxDir
      ? `\n\n--- Outbox (per-turn attachment dir) ---\nYour outbox for THIS turn is \`${outboxDir}\`. If you want to send Shawn a file (markdown summary, PDF, screenshot, voice clip, anything), write it into that dir. The bot flushes the outbox after your reply lands and sends each file as a Telegram attachment. Optional caption: write a sibling \`<filename>.caption.txt\` next to the file. Use this for long-form output (anything past ~6 lines): write the full thing as \`reply.md\` to the outbox and reply inline with a 2-sentence summary. Files starting with \`.\` are ignored.`
      : "";
    const fullPersona =
      PERSONA + (unlocked ? UNLOCKED_MODE_PROMPT : LOCKED_MODE_PROMPT) + outboxBlock;
    const args: string[] = [
      "-p",
      "--setting-sources",
      "project,local",
      "--mcp-config",
      MCP_CONFIG,
      "--append-system-prompt",
      fullPersona,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    if (unlocked) {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--allowedTools", LOCKED_ALLOWED_TOOLS);
    }
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let finalResult: { result?: string; session_id?: string; total_cost_usd?: number; num_turns?: number } | null = null;
    const pendingTools = new Map<number, { name: string; json: string }>();

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error(`turn timed out after ${TURN_TIMEOUT_MS / 1000}s`));
    }, TURN_TIMEOUT_MS);

    if (!child.stdout || !child.stdin || !child.stderr) {
      clearTimeout(timer);
      rejectP(new Error("claude subprocess missing stdio handles"));
      return;
    }

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line: string) => {
      if (!line.trim()) return;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }

      if (evt.type === "result") {
        finalResult = evt;
        return;
      }
      if (evt.type !== "stream_event") return;
      const inner = evt.event || {};
      if (inner.type === "message_start") {
        pendingTools.clear();
        return;
      }
      if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") {
        pendingTools.set(inner.index, { name: inner.content_block.name, json: "" });
        return;
      }
      if (inner.type === "content_block_delta" && inner.delta?.type === "input_json_delta") {
        const p = pendingTools.get(inner.index);
        if (p) p.json += inner.delta.partial_json || "";
        return;
      }
      if (inner.type === "content_block_stop") {
        const p = pendingTools.get(inner.index);
        if (!p) return;
        pendingTools.delete(inner.index);
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = p.json ? JSON.parse(p.json) : {};
        } catch {
          /* leave empty */
        }
        if (onToolUse) {
          try {
            onToolUse(p.name, parsedArgs);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn("onToolUse threw:", msg);
          }
        }
      }
    });

    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      rejectP(e);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectP(new Error(`claude exited ${code}: ${stderr.slice(-500) || "no stderr"}`));
        return;
      }
      if (!finalResult) {
        rejectP(new Error(`no result event in stream; stderr tail: ${stderr.slice(-300) || "(empty)"}`));
        return;
      }
      const fr = finalResult as { result?: string; session_id?: string; total_cost_usd?: number; num_turns?: number };
      resolveP({
        reply: fr.result || "",
        sessionId: fr.session_id || null,
        cost: fr.total_cost_usd || 0,
        turns: fr.num_turns || 0,
      });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

async function handleSlashCommand(text: string): Promise<boolean> {
  const cmd = text.split(/\s+/)[0]?.toLowerCase() ?? "";
  switch (cmd) {
    case "/reset":
    case "/new": {
      const old = currentSessionId;
      currentSessionId = null;
      saveSession(null);
      await sendMessage(
        `Session cleared. Next message starts a fresh thread.\n` +
          (old ? `(was: ${old})` : "(no prior session)")
      );
      return true;
    }
    case "/unlock": {
      const wasUnlocked = currentState.unlocked;
      currentState = { ...currentState, unlocked: true, unlocked_at: new Date().toISOString() };
      saveState(currentState);
      await sendMessage(
        wasUnlocked
          ? "🔓 Already unlocked. Send `/lock` when done with the current task."
          : "🔓 Unlocked. Full tools (Bash, Edit, Write, MCP writes) available on the next message.\n\nSend `/lock` or `/relock` to return to read-only safe mode."
      );
      return true;
    }
    case "/lock":
    case "/relock": {
      const wasUnlocked = currentState.unlocked;
      currentState = { ...currentState, unlocked: false };
      delete currentState.unlocked_at;
      saveState(currentState);
      await sendMessage(
        wasUnlocked
          ? "🔒 Locked. Read-only safe mode active. (Read, Grep, WebFetch, WebSearch, openmemory search/list/add - no Bash/Edit/Write.)"
          : "🔒 Already locked. Read-only mode."
      );
      return true;
    }
    case "/session":
    case "/status": {
      const sessionLine = currentSessionId
        ? `Session: ${currentSessionId}`
        : "Session: none (next message starts one)";
      const modeLine = currentState.unlocked
        ? `Mode: 🔓 UNLOCKED (full tools, since ${currentState.unlocked_at || "unknown"})`
        : "Mode: 🔒 LOCKED (read-only safe mode)";
      await sendMessage(`${sessionLine}\n${modeLine}`);
      return true;
    }
    case "/help": {
      await sendMessage(
        "Albus bot commands:\n\n" +
          "🔒 / 🔓  mode switcher\n" +
          "/unlock - switch to full tools (Bash, Edit, Write, etc.). Replies will end with a \"still unlocked - /lock when done\" reminder.\n" +
          "/lock or /relock - switch back to read-only safe mode.\n\n" +
          "🧵  conversation\n" +
          "/reset or /new - clear the Claude session, fresh thread (Mem0 stays).\n" +
          "/session or /status - show current session id and mode.\n" +
          "/help - this message.\n\n" +
          "Default mode is locked. Read-only by design - anything that touches the host or substrate needs an /unlock first."
      );
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Main per-message flow
// ---------------------------------------------------------------------------

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
      return { kind: "document", obj: msg.document, label: msg.document.file_name || "document" };
    }
    if (msg.voice) {
      return { kind: "voice", obj: msg.voice, label: `voice ${msg.voice.duration ?? "?"}s` };
    }
    if (msg.audio) {
      return { kind: "audio", obj: msg.audio, label: msg.audio.title || "audio" };
    }
    if (msg.video) return { kind: "video", obj: msg.video, label: "video" };
    if (msg.video_note) return { kind: "video", obj: msg.video_note, label: "video note" };
    return null;
  })();

  if (!hasPhoto && !hasText && !mediaAttachment) {
    return;
  }

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
    if (await handleSlashCommand(msg.text!)) return;
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
    await sendMessage("still working on the previous turn, queue this and try again in a moment");
    return;
  }
  busy = true;

  const turnStartedAt = Date.now();
  await sendTyping();
  const typingTimer = setInterval(() => {
    sendTyping();
  }, 4000);

  let scratchpadMessageId: number | null = null;
  const scratchpadLines: string[] = [];
  let scratchpadEditTimer: ReturnType<typeof setTimeout> | null = null;
  let scratchpadEditInFlight = false;
  let scratchpadDirty = false;

  const flushScratchpadEdit = async (): Promise<void> => {
    if (!scratchpadMessageId || !scratchpadDirty || scratchpadEditInFlight) return;
    scratchpadEditInFlight = true;
    scratchpadDirty = false;
    const text = scratchpadLines.slice(-20).join("\n").slice(0, 3800);
    try {
      await tg("editMessageText", {
        chat_id: Number(CHAT_ID),
        message_id: scratchpadMessageId,
        text,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.warn("scratchpad edit failed:", errMsg);
    } finally {
      scratchpadEditInFlight = false;
      if (scratchpadDirty) scheduleScratchpadEdit();
    }
  };

  const scheduleScratchpadEdit = (): void => {
    if (scratchpadEditTimer) return;
    scratchpadEditTimer = setTimeout(() => {
      scratchpadEditTimer = null;
      flushScratchpadEdit();
    }, 1500);
  };

  const closeScratchpad = async (): Promise<void> => {
    if (scratchpadEditTimer) {
      clearTimeout(scratchpadEditTimer);
      scratchpadEditTimer = null;
    }
    if (!scratchpadMessageId) return;
    const id = scratchpadMessageId;
    scratchpadMessageId = null;
    try {
      await tg("deleteMessage", { chat_id: Number(CHAT_ID), message_id: id });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.warn("scratchpad delete failed:", errMsg);
    }
  };

  const onToolUse: ToolUseCallback = (name, args) => {
    scratchpadLines.push(describeToolCall(name, args));
    scratchpadDirty = true;
    if (!scratchpadMessageId) {
      (async () => {
        try {
          const sent = await tg<{ message_id: number }>("sendMessage", {
            chat_id: Number(CHAT_ID),
            text: "🪄 working...",
          });
          scratchpadMessageId = sent.message_id;
          scheduleScratchpadEdit();
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.warn("scratchpad open failed:", errMsg);
        }
      })();
    } else {
      scheduleScratchpadEdit();
    }
  };

  try {
    let result: ClaudeTurnResult;
    try {
      result = await spawnAlbus(userInput, currentSessionId, currentState.unlocked, onToolUse, turnOutbox);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const looksLikeSessionLoss = currentSessionId && /session|resume|jsonl/i.test(errMsg);
      if (looksLikeSessionLoss) {
        console.warn(`resume failed for ${currentSessionId}, starting fresh: ${errMsg}`);
        currentSessionId = null;
        saveSession(null);
        result = await spawnAlbus(userInput, null, currentState.unlocked, onToolUse, turnOutbox);
      } else {
        throw e;
      }
    }
    if (result.sessionId && result.sessionId !== currentSessionId) {
      currentSessionId = result.sessionId;
      saveSession(currentSessionId);
    }
    await closeScratchpad();
    await sendMessage(result.reply || "(no reply)");
    let outboxSent = 0;
    try {
      outboxSent = await flushOutbox(turnOutbox);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("flushOutbox failed:", errMsg);
    }
    const elapsedS = ((Date.now() - turnStartedAt) / 1000).toFixed(1);
    console.log(
      `  -> sent ${result.reply.length} chars, session=${result.sessionId?.slice(0, 8)}, ` +
        `turns=${result.turns}, cost=$${result.cost.toFixed(4)}, ` +
        `mode=${currentState.unlocked ? "unlocked" : "locked"}, ` +
        `tools=${scratchpadLines.length}, attachments=${outboxSent}, elapsed=${elapsedS}s`
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("turn failed:", errMsg);
    if (scratchpadMessageId) {
      scratchpadLines.push(`💥 spell fizzled: ${errMsg.slice(0, 200)}`);
      scratchpadDirty = true;
      await flushScratchpadEdit();
    } else {
      await sendMessage(`bot error: ${errMsg}`);
    }
  } finally {
    clearInterval(typingTimer);
    busy = false;
  }
}

async function pollLoop(): Promise<void> {
  console.log(
    `albus-tg-bot started, watching chat_id=${CHAT_ID}, ` +
      `session=${currentSessionId ? currentSessionId.slice(0, 8) + "..." : "(none, will start fresh on first message)"}, ` +
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

pollLoop().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
