// All Telegram bot API surface in one place. Pure HTTP, no scratchpad state,
// no Claude knowledge. Other modules (outbox, scratchpad, poll) import these
// rather than reaching for `fetch` directly.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { CHAT_ID, TG_API, TG_MSG_MAX, TOKEN, PHOTOS_DIR } from "./config.ts";
import { formatForTelegram } from "./format.ts";

interface TgResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TgFile {
  file_id: string;
  file_path?: string;
  mime_type?: string;
  file_name?: string;
  title?: string;
  duration?: number;
}

export async function tg<T = unknown>(method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${TG_API}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as TgResponse<T>;
  if (!data.ok) throw new Error(`tg ${method}: ${data.description || "unknown error"}`);
  return data.result as T;
}

export async function sendMessage(
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
      // HTML parse failures should not silently swallow the message.
      // Fall back to plain text so the user still sees something.
      if (markdown && /can't parse|parse_mode|entities/i.test(msg)) {
        console.warn("HTML parse failed, sending plain:", msg);
        await tg("sendMessage", { chat_id: Number(CHAT_ID), text: chunk });
      } else {
        throw e;
      }
    }
  }
}

export async function sendTyping(): Promise<void> {
  try {
    await tg("sendChatAction", { chat_id: Number(CHAT_ID), action: "typing" });
  } catch {
    /* typing indicator is non-critical */
  }
}

// Route attachments by extension. Images go via sendPhoto for the inline
// preview; voice (.ogg/.oga/.opus) via sendVoice for the native mic UI;
// everything else as sendDocument.
export async function sendAttachment(
  filePath: string,
  caption?: string
): Promise<unknown> {
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

// Download any Telegram file (photo, document, voice, etc.) to PHOTOS_DIR
// and return the absolute path. Caller decides what to do with it; usually
// references it in the prompt so Claude can Read the file.
export async function downloadFile(
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
