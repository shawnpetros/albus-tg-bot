// Claude subprocess management. Spawns `claude -p` per turn with the
// streaming JSON output format, parses each line, surfaces tool_use events
// via the injected onToolUse callback, and resolves with the final
// result/session/cost/turns when the process closes cleanly.
//
// No knowledge of Telegram or the bot's persona file: the caller assembles
// the full system prompt (persona + mode + outbox) and passes it as
// fullPersona. Same for tool callback: caller wires it to a scratchpad.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  MCP_CONFIG,
  LOCKED_ALLOWED_TOOLS,
  TURN_TIMEOUT_MS,
  LOCKED_MODE_PROMPT,
  UNLOCKED_MODE_PROMPT,
  QUICK_TIMEOUT_MS,
} from "./config.ts";

export interface ClaudeTurnResult {
  reply: string;
  sessionId: string | null;
  cost: number;
  turns: number;
  // Cumulative billed input across every internal step in the turn, derived
  // from the result event's `usage`. Right for cost reasoning, WRONG for "how
  // big is the session" — a multi-tool turn re-reads the cache each step so
  // this stacks into the millions, past the context window. Kept for logging
  // ONLY. Never gate compaction on this. See contextTokens.
  promptTokens: number;
  // True context fill: the input-side total of the LAST assistant message that
  // carried a usage block in the turn. One round-trip's view of the
  // conversation — what the next --resume actually carries. THIS is what gates
  // compaction in poll.ts. ~50-59k in practice, not millions.
  contextTokens: number;
  contextWindow: number | null;
  costUsd: number;
}

// A single assistant message's input usage, as it appears on
// `message.usage` / `message_start.message.usage` in the stream. Any field may
// be absent.
export interface AssistantUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface UsageInfo {
  // True context fill (last assistant message's input-side total). 0 when no
  // assistant usage was seen (e.g. an errored turn).
  contextTokens: number;
  // Cumulative turn cost from the result event. Correct as-is.
  costUsd: number;
}

function blockTokens(u: AssistantUsage | null | undefined): number {
  if (!u) return 0;
  return (
    (u.input_tokens || 0) +
    (u.cache_read_input_tokens || 0) +
    (u.cache_creation_input_tokens || 0)
  );
}

// Reduce a turn's per-message usage blocks + the result event into the two
// numbers that matter: the true context fill and the cumulative cost.
//
// contextTokens is the LAST assistant message's input-side total, NOT the sum.
// The result event's `usage` is cumulative across every internal API call in
// the agentic turn (it stacks cache re-reads into the millions and can exceed
// the context window) — so it is deliberately ignored for context sizing and
// used only for cost. This is the fix for the false-fire compaction bug.
//
// Defensive: missing/empty inputs yield contextTokens 0 and cost 0, never
// throws.
export function extractUsage(
  assistantUsages: AssistantUsage[] | null | undefined,
  resultEvent: any
): UsageInfo {
  const blocks = Array.isArray(assistantUsages) ? assistantUsages : [];
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;
  const contextTokens = blockTokens(last);

  const evt = resultEvent || {};
  const modelUsage = evt.modelUsage || {};
  const models = Object.values(modelUsage) as Array<{ costUSD?: number }>;

  let costUsd: number;
  if (typeof evt.total_cost_usd === "number") {
    costUsd = evt.total_cost_usd;
  } else {
    costUsd = models.reduce((sum, m) => sum + (m?.costUSD || 0), 0);
  }

  return { contextTokens, costUsd };
}

// Pull the max contextWindow advertised across modelUsage entries from a
// result event, or null if none. Kept separate from extractUsage (which is
// about the turn's own numbers); the window is a model capability, not usage.
export function extractContextWindow(resultEvent: any): number | null {
  const modelUsage = (resultEvent || {}).modelUsage || {};
  const models = Object.values(modelUsage) as Array<{ contextWindow?: number }>;
  let contextWindow: number | null = null;
  for (const m of models) {
    if (typeof m?.contextWindow === "number") {
      contextWindow =
        contextWindow === null
          ? m.contextWindow
          : Math.max(contextWindow, m.contextWindow);
    }
  }
  return contextWindow;
}

export type ToolUseCallback = (
  name: string,
  args: Record<string, unknown>
) => void;

export interface SpawnOptions {
  input: string;
  sessionId: string | null;
  unlocked: boolean;
  onToolUse: ToolUseCallback | null;
  outboxDir: string;
  persona: string;
  // Resolved model id to pass via `--model`, or null for the CLI default.
  model: string | null;
}

function buildOutboxBlock(outboxDir: string): string {
  if (!outboxDir) return "";
  return (
    `\n\n--- Outbox (per-turn attachment dir) ---\n` +
    `Your outbox for THIS turn is \`${outboxDir}\`. If you want to send a file (markdown summary, PDF, screenshot, voice clip, anything), write it into that dir. The bot flushes the outbox after your reply lands and sends each file as a Telegram attachment. Optional caption: write a sibling \`<filename>.caption.txt\` next to the file. Use this for long-form output (anything past ~6 lines): write the full thing as \`reply.md\` to the outbox and reply inline with a 2-sentence summary. Files starting with \`.\` are ignored.`
  );
}

export function spawnAlbus(opts: SpawnOptions): Promise<ClaudeTurnResult> {
  const { input, sessionId, unlocked, onToolUse, outboxDir, persona, model } =
    opts;
  return new Promise((resolveP, rejectP) => {
    const fullPersona =
      persona +
      (unlocked ? UNLOCKED_MODE_PROMPT : LOCKED_MODE_PROMPT) +
      buildOutboxBlock(outboxDir);
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
    if (model) {
      args.push("--model", model);
    }
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
    let finalResult: {
      result?: string;
      session_id?: string;
      total_cost_usd?: number;
      num_turns?: number;
    } | null = null;
    // Per-message input usage, one entry per assistant message that carried a
    // usage block (each message_start reports that round-trip's input view).
    // extractUsage takes the LAST as the true context fill. Collected as a
    // list so the helper stays pure/testable rather than us pre-reducing here.
    const assistantUsages: AssistantUsage[] = [];
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
      // Each stream-json line is its own JSON envelope; skip non-JSON noise.
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
        const u = inner.message?.usage;
        if (u) {
          assistantUsages.push({
            input_tokens: u.input_tokens,
            cache_read_input_tokens: u.cache_read_input_tokens,
            cache_creation_input_tokens: u.cache_creation_input_tokens,
          });
        }
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
        rejectP(
          new Error(
            `no result event in stream; stderr tail: ${stderr.slice(-300) || "(empty)"}`
          )
        );
        return;
      }
      const fr = finalResult as {
        result?: string;
        session_id?: string;
        total_cost_usd?: number;
        num_turns?: number;
      };
      const usage = extractUsage(assistantUsages, fr);
      // promptTokens (cumulative) is for the log line only; the result event's
      // own usage drives it. Compaction gates on usage.contextTokens.
      const ru = (fr as { usage?: AssistantUsage }).usage;
      const promptTokens = blockTokens(ru);
      resolveP({
        reply: fr.result || "",
        sessionId: fr.session_id || null,
        cost: fr.total_cost_usd || 0,
        turns: fr.num_turns || 0,
        promptTokens,
        contextTokens: usage.contextTokens,
        contextWindow: extractContextWindow(fr),
        costUsd: usage.costUsd,
      });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

// Run a headless /compact against an existing session. No persona, mode, or
// outbox decoration: this is a maintenance op, not a turn. Compaction keeps
// the same session_id, so on success the caller's session file needs no
// change. Resolves true on a clean exit, false on timeout or non-zero exit
// (the caller treats a false as non-fatal and carries on). Uses the same
// SIGKILL-on-timeout guard as spawnAlbus.
export function compactSession(sessionId: string): Promise<boolean> {
  return new Promise((resolveP) => {
    const args = [
      "-p",
      "/compact",
      "--resume",
      sessionId,
      "--output-format",
      "json",
    ];
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(ok);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, TURN_TIMEOUT_MS);

    child.on("error", () => finish(false));
    child.on("close", (code: number | null) => finish(code === 0));

    // No input to send; /compact is driven entirely by the arg.
    child.stdin?.end();
  });
}

export interface QuickOptions {
  input: string;
  system: string;
  model: string;
}

// Pure: the arg vector for a stripped, sessionless, toolless aside call.
// No --resume (no session replay), empty --setting-sources (no skills),
// --mcp-config '{}' + --strict-mcp-config (no MCP servers). These three are
// the entire latency win; the system prompt (voice card) is essentially free.
export function buildQuickArgs(opts: { system: string; model: string }): string[] {
  return [
    "-p",
    "--append-system-prompt",
    opts.system,
    "--model",
    opts.model,
    "--output-format",
    "json",
    "--setting-sources",
    "",
    "--mcp-config",
    // A valid-but-empty config: the CLI rejects bare "{}" ("Invalid MCP
    // configuration"). With --strict-mcp-config this loads zero servers.
    '{"mcpServers":{}}',
    "--strict-mcp-config",
  ];
}

// Run a stripped fast aside. Returns the reply text on a clean exit; rejects on
// timeout, non-zero exit, or unparseable output. Callers treat it best-effort.
export function spawnQuick(opts: QuickOptions): Promise<string> {
  const { input, system, model } = opts;
  return new Promise((resolveP, rejectP) => {
    const child = spawn("claude", buildQuickArgs({ system, model }), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectP(err);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`quick aside timed out after ${QUICK_TIMEOUT_MS / 1000}s`));
    }, QUICK_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e: Error) => fail(e));
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectP(new Error(`quick aside exited ${code}: ${stderr.slice(-300) || "no stderr"}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: string };
        resolveP(parsed.result || "");
      } catch {
        rejectP(new Error(`quick aside: unparseable output: ${stdout.slice(0, 200)}`));
      }
    });

    child.stdin?.write(input);
    child.stdin?.end();
  });
}
