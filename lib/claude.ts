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
} from "./config.ts";

export interface ClaudeTurnResult {
  reply: string;
  sessionId: string | null;
  cost: number;
  turns: number;
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
}

function buildOutboxBlock(outboxDir: string): string {
  if (!outboxDir) return "";
  return (
    `\n\n--- Outbox (per-turn attachment dir) ---\n` +
    `Your outbox for THIS turn is \`${outboxDir}\`. If you want to send Shawn a file (markdown summary, PDF, screenshot, voice clip, anything), write it into that dir. The bot flushes the outbox after your reply lands and sends each file as a Telegram attachment. Optional caption: write a sibling \`<filename>.caption.txt\` next to the file. Use this for long-form output (anything past ~6 lines): write the full thing as \`reply.md\` to the outbox and reply inline with a 2-sentence summary. Files starting with \`.\` are ignored.`
  );
}

export function spawnAlbus(opts: SpawnOptions): Promise<ClaudeTurnResult> {
  const { input, sessionId, unlocked, onToolUse, outboxDir, persona } = opts;
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
