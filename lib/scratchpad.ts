// The wizarding tool-call scratchpad. On the first tool_use of a turn, we
// open a Telegram message and edit it in place as each subsequent tool fires,
// then delete it once the final reply lands. If the turn errors out we leave
// the last edit visible with a fizzle marker so diagnostics survive.
//
// Telegram dependency is injected so the scratchpad is testable without a
// real bot. State (messageId, lines, timers) lives in the closure returned
// from `createScratchpad`.

export interface ScratchpadDeps {
  chatId: number;
  send: (method: string, body: unknown) => Promise<{ message_id?: number } | unknown>;
}

export interface Scratchpad {
  // Push a description line and (if first call) open the message. Safe to
  // call from inside tool-stream callbacks; fire-and-forget for telegram I/O.
  onToolUse: (description: string) => void;
  // Final cleanup: delete the scratchpad message. Idempotent.
  close: () => Promise<void>;
  // Mark the scratchpad with an error line, edit in place, do NOT delete.
  error: (description: string) => Promise<void>;
  // Number of tool lines accumulated this turn. Used by the caller for logs.
  toolCount: () => number;
}

// Tool-name to wizarding-flavour mapping. Pure; safe to call standalone.
// Lives here because the scratchpad is the only caller today; if a second
// caller ever shows up it can move to its own module.
export function describeToolCall(
  name: string,
  args: Record<string, unknown>
): string {
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

export function createScratchpad(deps: ScratchpadDeps): Scratchpad {
  const { chatId, send } = deps;
  let messageId: number | null = null;
  const lines: string[] = [];
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let editInFlight = false;
  let dirty = false;

  const flushEdit = async (): Promise<void> => {
    if (!messageId || !dirty || editInFlight) return;
    editInFlight = true;
    dirty = false;
    const text = lines.slice(-20).join("\n").slice(0, 3800);
    try {
      await send("editMessageText", { chat_id: chatId, message_id: messageId, text });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.warn("scratchpad edit failed:", m);
    } finally {
      editInFlight = false;
      if (dirty) scheduleEdit();
    }
  };

  const scheduleEdit = (): void => {
    if (editTimer) return;
    editTimer = setTimeout(() => {
      editTimer = null;
      flushEdit();
    }, 1500);
  };

  const onToolUse = (description: string): void => {
    lines.push(description);
    dirty = true;
    if (!messageId) {
      // Lazy-open on the first tool call. Fire-and-forget; the next debounced
      // edit will populate. Don't await inside the tool-stream callback.
      (async () => {
        try {
          const sent = (await send("sendMessage", {
            chat_id: chatId,
            text: "🪄 working...",
          })) as { message_id: number };
          messageId = sent.message_id;
          scheduleEdit();
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          console.warn("scratchpad open failed:", m);
        }
      })();
    } else {
      scheduleEdit();
    }
  };

  const close = async (): Promise<void> => {
    if (editTimer) {
      clearTimeout(editTimer);
      editTimer = null;
    }
    if (!messageId) return;
    const id = messageId;
    messageId = null;
    try {
      await send("deleteMessage", { chat_id: chatId, message_id: id });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.warn("scratchpad delete failed:", m);
    }
  };

  const error = async (description: string): Promise<void> => {
    lines.push(description);
    dirty = true;
    await flushEdit();
  };

  return {
    onToolUse,
    close,
    error,
    toolCount: () => lines.length,
  };
}
