// The tool-call scratchpad. On the first tool_use of a turn, we
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
  // Don't open the live message for a streamed reply until it crosses this many
  // characters (short replies arrive whole, no preview flicker). Tool calls
  // always open immediately regardless. Default 0 (open on any text).
  minStreamChars?: number;
}

export interface Scratchpad {
  // Push a description line and (if first call) open the message. Safe to
  // call from inside tool-stream callbacks; fire-and-forget for telegram I/O.
  onToolUse: (description: string) => void;
  // Surface the streaming reply text (full accumulated text so far) as a live
  // preview in the same message. Lazy-opens once past minStreamChars. Once text
  // is flowing it takes over the message from the tool-progress lines.
  streamText: (fullText: string) => void;
  // Final cleanup: delete the scratchpad message. Idempotent.
  close: () => Promise<void>;
  // Mark the scratchpad with an error line, edit in place, do NOT delete.
  error: (description: string) => Promise<void>;
  // Number of tool lines accumulated this turn. Used by the caller for logs.
  toolCount: () => number;
}

// Tool-name to Jarvis-flavour mapping. Pure; safe to call standalone.
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
      return `⚙️ running: ${clip(args.description ?? args.command)}`;
    case "Edit":
      return `✍️ patching ${basename(args.file_path)}`;
    case "Write":
      return `📝 writing ${basename(args.file_path)}`;
    case "Read":
      return `📖 reading ${basename(args.file_path)}`;
    case "Grep":
      return `🔍 searching for "${clip(args.pattern)}"`;
    case "Glob":
      return `🗂️ scanning "${clip(args.pattern)}"`;
    case "WebFetch": {
      let host = "";
      try {
        host = new URL(String(args.url)).host;
      } catch {
        /* invalid URL; show no host */
      }
      return host ? `🌐 fetching ${host}` : "🌐 fetching";
    }
    case "WebSearch":
      return `🔎 searching the web: "${clip(args.query)}"`;
    case "Task":
      return `🤖 dispatching agent: ${clip(args.description)}`;
    case "TodoWrite":
      return `📋 tracking ${Array.isArray(args.todos) ? args.todos.length : 0} todos`;
    default:
      if (name.startsWith("mcp__")) {
        const frag = name.replace(/^mcp__/, "").replace(/__/g, " ");
        if (/add|save|write|create|set|update|delete/i.test(name)) {
          return `💾 committing: ${frag}`;
        }
        return `🔭 querying: ${frag}`;
      }
      return `⚙️ running ${name}`;
  }
}

export function createScratchpad(deps: ScratchpadDeps): Scratchpad {
  const { chatId, send, minStreamChars = 0 } = deps;
  let messageId: number | null = null;
  let opening = false;
  const lines: string[] = [];
  // Full accumulated reply text once streaming begins. When non-empty it takes
  // over the live message from the tool-progress lines.
  let streamedText = "";
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let editInFlight = false;
  let dirty = false;

  // What the live message should currently show: the streaming reply (tail,
  // since that's where new text lands) once it exists, else tool progress.
  const renderText = (): string => {
    if (streamedText) {
      const tail = streamedText.slice(-3800);
      return tail.length < streamedText.length ? `…${tail}` : tail;
    }
    return lines.slice(-20).join("\n").slice(0, 3800);
  };

  // Lazy-open the live message exactly once. Guarded by `opening` so the rapid
  // fire of streamText (one call per text delta) can't race several
  // sendMessage calls before the first resolves and sets messageId.
  const ensureOpen = (): void => {
    if (messageId || opening) return;
    opening = true;
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
      } finally {
        opening = false;
      }
    })();
  };

  const flushEdit = async (): Promise<void> => {
    if (!messageId || !dirty || editInFlight) return;
    editInFlight = true;
    dirty = false;
    const text = renderText();
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
    if (!messageId) ensureOpen();
    else scheduleEdit();
  };

  const streamText = (fullText: string): void => {
    streamedText = fullText;
    dirty = true;
    if (!messageId) {
      // Hold off opening until the reply is substantial enough to be worth a
      // live preview; short replies just arrive whole via the normal send.
      if (fullText.length >= minStreamChars) ensureOpen();
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
    streamText,
    close,
    error,
    toolCount: () => lines.length,
  };
}
