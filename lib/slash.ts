// Slash-command router. The bot's per-message handler delegates to this
// when an incoming message starts with `/` and has no media attached.
// State (session, lock mode) is exposed via deps so this module never
// touches the filesystem directly; that keeps the router pure-ish and
// the bot in control of when persistence happens.

import type { BotState } from "./state.ts";

export interface SlashDeps {
  getSession: () => string | null;
  clearSession: () => void;
  getState: () => BotState;
  setUnlocked: (next: BotState) => void;
  sendMessage: (text: string, opts?: { markdown?: boolean }) => Promise<void>;
}

export async function handleSlashCommand(
  text: string,
  deps: SlashDeps
): Promise<boolean> {
  const cmd = text.split(/\s+/)[0]?.toLowerCase() ?? "";
  switch (cmd) {
    case "/reset":
    case "/new": {
      const old = deps.getSession();
      deps.clearSession();
      await deps.sendMessage(
        `Session cleared. Next message starts a fresh thread.\n` +
          (old ? `(was: ${old})` : "(no prior session)")
      );
      return true;
    }
    case "/unlock": {
      const current = deps.getState();
      const wasUnlocked = current.unlocked;
      deps.setUnlocked({
        ...current,
        unlocked: true,
        unlocked_at: new Date().toISOString(),
      });
      await deps.sendMessage(
        wasUnlocked
          ? "🔓 Already unlocked. Send `/lock` when done with the current task."
          : "🔓 Unlocked. Full tools (Bash, Edit, Write, MCP writes) available on the next message.\n\nSend `/lock` or `/relock` to return to read-only safe mode."
      );
      return true;
    }
    case "/lock":
    case "/relock": {
      const current = deps.getState();
      const wasUnlocked = current.unlocked;
      const next: BotState = { ...current, unlocked: false };
      delete next.unlocked_at;
      deps.setUnlocked(next);
      await deps.sendMessage(
        wasUnlocked
          ? "🔒 Locked. Read-only safe mode active. (Read, Grep, WebFetch, WebSearch, openmemory search/list/add - no Bash/Edit/Write.)"
          : "🔒 Already locked. Read-only mode."
      );
      return true;
    }
    case "/session":
    case "/status": {
      const sid = deps.getSession();
      const state = deps.getState();
      const sessionLine = sid
        ? `Session: ${sid}`
        : "Session: none (next message starts one)";
      const modeLine = state.unlocked
        ? `Mode: 🔓 UNLOCKED (full tools, since ${state.unlocked_at || "unknown"})`
        : "Mode: 🔒 LOCKED (read-only safe mode)";
      await deps.sendMessage(`${sessionLine}\n${modeLine}`);
      return true;
    }
    case "/help": {
      await deps.sendMessage(
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
