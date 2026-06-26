#!/usr/bin/env bun
// albus-tg-bot - Telegram surface for Jarvis. (Repo/path names stay "albus-*"
// as inert infrastructure; the persona/identity is Jarvis.)
//
// Long-polls Telegram getUpdates, spawns `claude -p` per message with
// Honcho MCP memory access and the Jarvis persona, sends the response back.
//
// This file is intentionally tiny. All the work happens in lib/:
//   lib/config.ts     env vars, paths, constants, mode prompts
//   lib/state.ts      session.json + state.json persistence
//   lib/format.ts     CommonMark -> Telegram HTML converter
//   lib/telegram.ts   tg/sendMessage/sendAttachment/sendTyping/downloadFile
//   lib/outbox.ts     per-turn attachment dir flush
//   lib/scratchpad.ts tool-call display lifecycle
//   lib/claude.ts     spawnAlbus subprocess + stream-json parser
//   lib/slash.ts      /reset /lock /unlock /session /status /help router
//   lib/poll.ts       handleUpdate + the main poll loop
//
// Authorized for a single chat_id (env: ALBUS_BOT_CHAT_ID).

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import {
  PERSONA_PATH,
  PERSONA_LOCAL_PATH,
  STATE_DIR,
  PHOTOS_DIR,
  OUTBOX_DIR,
} from "./lib/config.ts";
import { startBot } from "./lib/poll.ts";

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(PHOTOS_DIR, { recursive: true });
mkdirSync(OUTBOX_DIR, { recursive: true });

// Persona: base ships in the repo; if ~/.config/albus/persona.local.md exists,
// it's appended below as the operator's overlay. See PERSONA_LOCAL_PATH.
let persona = readFileSync(PERSONA_PATH, "utf8");
if (existsSync(PERSONA_LOCAL_PATH)) {
  const overlay = readFileSync(PERSONA_LOCAL_PATH, "utf8").trim();
  if (overlay) {
    persona += `\n\n---\n\n${overlay}\n`;
  }
}

startBot({ persona }).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
