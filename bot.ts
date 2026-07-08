#!/usr/bin/env bun
// tgclaude - a Telegram surface for your Claude Code.
// Persona is pluggable via the local overlay (see persona.md).
//
// Long-polls Telegram getUpdates, spawns `claude -p` per message with
// any configured MCP servers and the persona, sends the response back.
//
// This file is intentionally tiny. All the work happens in lib/:
//   lib/config.ts     env vars, paths, constants, mode prompts
//   lib/state.ts      session.json + state.json persistence
//   lib/format.ts     CommonMark -> Telegram HTML converter
//   lib/telegram.ts   tg/sendMessage/sendAttachment/sendTyping/downloadFile
//   lib/outbox.ts     per-turn attachment dir flush
//   lib/scratchpad.ts tool-call display lifecycle
//   lib/claude.ts     spawnClaude subprocess + stream-json parser
//   lib/slash.ts      /reset /lock /unlock /session /status /help router
//   lib/poll.ts       handleUpdate + the main poll loop
//
// Authorized for a single chat_id (env: TGCLAUDE_BOT_CHAT_ID).

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

// Persona: base ships in the repo; if <config-dir>/persona.local.md exists,
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
