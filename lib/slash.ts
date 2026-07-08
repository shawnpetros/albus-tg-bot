// Slash-command router. The bot's per-message handler delegates to this
// when an incoming message starts with `/` and has no media attached.
// State (session, lock mode) is exposed via deps so this module never
// touches the filesystem directly; that keeps the router pure-ish and
// the bot in control of when persistence happens.

import type { BotState, SessionRecord } from "./state.ts";

export interface SlashDeps {
  getSession: () => string | null;
  clearSession: () => void;
  getState: () => BotState;
  setUnlocked: (next: BotState) => void;
  // Full current-session record (accounting included) for status display, or
  // null when there's no session / the file is missing or corrupt.
  getSessionRecord: () => SessionRecord | null;
  // Queue a manual compaction pass. Runs on the serial turn queue (after any
  // in-flight turn), so this just signals intent; it does not block.
  requestCompact: () => void;
  // Set (string) or clear (null) the per-bot model override. Persisted by the
  // caller; takes effect on the next spawned turn.
  setModel: (model: string | null) => void;
  sendMessage: (text: string, opts?: { markdown?: boolean }) => Promise<void>;
}

// Map a friendly model token ("opus", "opus 4.8", "claude-opus-4-8") to a
// resolved model id. The match is by family substring, so both bare aliases
// and full ids land on the same pinned id. Unknown tokens pass through
// verbatim so future/explicit ids still work without a code change.
export function resolveModelAlias(raw: string): string {
  const norm = raw.trim().toLowerCase();
  if (norm.includes("opus")) return "claude-opus-4-8";
  if (norm.includes("sonnet")) return "claude-sonnet-4-6";
  if (norm.includes("haiku")) return "claude-haiku-4-5-20251001";
  return raw.trim();
}

// Render a created_at ISO timestamp as a friendly age like "2h 13m" or "45m"
// or "3d 4h". Returns "—" when the input is missing or unparseable.
function formatAge(createdAt: string | undefined): string {
  if (!createdAt) return "—";
  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) return "—";
  let secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const days = Math.floor(secs / 86_400);
  secs -= days * 86_400;
  const hours = Math.floor(secs / 3600);
  secs -= hours * 3600;
  const mins = Math.floor(secs / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
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
          ? "🔒 Locked. Read-only safe mode active. (Read, Grep, WebFetch, WebSearch - no Bash/Edit/Write, no memory writes.)"
          : "🔒 Already locked. Read-only mode."
      );
      return true;
    }
    case "/session":
    case "/status": {
      const sid = deps.getSession();
      const state = deps.getState();
      const rec = deps.getSessionRecord();
      const sessionLine = sid
        ? `Session: ${sid}`
        : "Session: none (next message starts one)";
      const modeLine = state.unlocked
        ? `Mode: 🔓 UNLOCKED (full tools, since ${state.unlocked_at || "unknown"})`
        : "Mode: 🔒 LOCKED (read-only safe mode)";
      const modelLine = `Model: ${state.model ? state.model : "default (opus 4.8)"}`;

      // Current-session stats. Each field degrades to a placeholder when the
      // record is absent or the field is missing (legacy files).
      const turnsStr =
        typeof rec?.turns === "number" ? String(rec.turns) : "none";
      const ctxStr =
        typeof rec?.last_prompt_tokens === "number"
          ? `~${Math.round(rec.last_prompt_tokens / 1000)}k tokens`
          : "—";
      const costStr =
        typeof rec?.total_cost_usd === "number"
          ? `$${rec.total_cost_usd.toFixed(4)}`
          : "—";
      const ageStr = formatAge(rec?.created_at);

      const statsLines = [
        `Turns: ${turnsStr}`,
        `Context: ${ctxStr}`,
        `Cost: ${costStr}`,
        `Age: ${ageStr}`,
      ].join("\n");

      await deps.sendMessage(`${sessionLine}\n${modeLine}\n${modelLine}\n\n${statsLines}`);
      return true;
    }
    case "/model": {
      const arg = text.slice(cmd.length).trim();
      const current = deps.getState();
      if (!arg) {
        const m = current.model;
        await deps.sendMessage(
          m
            ? `Model: \`${m}\`\n\nChange with \`/model sonnet\` (or opus/haiku), \`/model default\` to clear.`
            : "Model: default (opus 4.8, no override set).\n\nSet with `/model opus`, `/model sonnet`, or `/model haiku`."
        );
        return true;
      }
      if (/^(default|reset|clear|auto)$/i.test(arg)) {
        deps.setModel(null);
        await deps.sendMessage("Model override cleared. Back to the default (opus 4.8) on the next message.");
        return true;
      }
      const model = resolveModelAlias(arg);
      deps.setModel(model);
      await deps.sendMessage(`Model set to \`${model}\`. Takes effect on the next message.`);
      return true;
    }
    case "/compact": {
      const sid = deps.getSession();
      if (!sid) {
        await deps.sendMessage("Nothing to compact — no current session.");
        return true;
      }
      deps.requestCompact();
      await deps.sendMessage(
        "queued a compaction — running after the current turn if any."
      );
      return true;
    }
    case "/help": {
      await deps.sendMessage(
        "Bot commands:\n\n" +
          "🔒 / 🔓  mode switcher\n" +
          "/unlock - switch to full tools (Bash, Edit, Write, etc.). Replies will end with a \"still unlocked - /lock when done\" reminder.\n" +
          "/lock or /relock - switch back to read-only safe mode.\n\n" +
          "🧵  conversation\n" +
          "/reset or /new - clear the Claude session, fresh thread (long-term memory, if attached, stays).\n" +
          "/session or /status - show current session id, mode, and stats (turns, context size, cost, age).\n" +
          "/compact - manually trigger a compaction pass on the current session.\n" +
          "/model - show the current model; `/model opus|sonnet|haiku` to switch, `/model default` to clear.\n" +
          "/help - this message.\n\n" +
          "Default mode is locked. Read-only by design - anything that touches the host or substrate needs an /unlock first."
      );
      return true;
    }
    default:
      return false;
  }
}
