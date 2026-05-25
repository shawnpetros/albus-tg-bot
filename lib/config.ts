// Centralised configuration: env vars, paths, constants, mode-context prompts.
// No I/O at module load beyond env reads; everything else is exported and
// consumed lazily by other modules. The required-env check fails fast at
// module load so the bot dies in the launchd log rather than mid-handle.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

// Resolve the project root once. lib/config.ts lives at <root>/lib/, so the
// parent of this file's dir is the bot's root.
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(LIB_DIR, "..");

export const TOKEN = process.env.ALBUS_BOT_TOKEN;
export const CHAT_ID = process.env.ALBUS_BOT_CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  throw new Error(
    "ALBUS_BOT_TOKEN and ALBUS_BOT_CHAT_ID required in env. source ~/.exports"
  );
}

export const TG_API = `https://api.telegram.org/bot${TOKEN}`;
export const TURN_TIMEOUT_MS = 10 * 60 * 1000;
export const TG_MSG_MAX = 4000;

// Source files
export const PERSONA_PATH = resolve(PROJECT_ROOT, "persona.md");
export const MCP_CONFIG = resolve(PROJECT_ROOT, "mcp-config.json");

// State paths
export const STATE_DIR = `${homedir()}/.albus-tg-bot`;
export const SESSION_FILE = `${STATE_DIR}/session.json`;
export const STATE_FILE = `${STATE_DIR}/state.json`;
export const PHOTOS_DIR = `${STATE_DIR}/photos`;
export const OUTBOX_DIR = `${STATE_DIR}/outbox`;

// Locked-mode tool allowlist: pure read. Excludes anything that mutates host,
// substrate, or external state. Memory writes (add_memories, delete_memories)
// require /unlock so the substrate can't drift behind your back. TodoWrite is
// in-context-only, no external side effects, kept for agent planning ergonomics.
export const LOCKED_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "mcp__openmemory__search_memory",
  "mcp__openmemory__list_memories",
].join(",");

export const LOCKED_MODE_PROMPT = `

--- Mode context (auto-injected by the bot harness, do not include in reply) ---
You are currently in **🔒 LOCKED / read-only safe mode**.

Available tools: Read, Grep, Glob, WebFetch, WebSearch, Task, TodoWrite, openmemory **search and list only** (read-only memory access).
Disabled tools: Bash, Edit, Write, NotebookEdit, openmemory **add/delete** (no memory writes either), anything that mutates the host or the substrate.

If Shawn asks for an action that requires a disabled tool (run a command, edit a file, delete memory, push code, send a message, etc.), DO NOT try to use it. Reply with what you'd do and tell him to send \`/unlock\` first. Then he can re-send the original ask.

Don't add any mode footer to your reply. The bot harness handles UI affordances; your job is just to respect the read-only boundary.`;

export const UNLOCKED_MODE_PROMPT = `

--- Mode context (auto-injected by the bot harness, do not include in reply) ---
You are currently in **🔓 UNLOCKED mode**. Full tools available: Bash, Edit, Write, openmemory full surface, the works. Use \`--dangerously-skip-permissions\`-equivalent agency on the host machine.

**Always append this exact line as the LAST line of your reply** (after a blank line, no other formatting):

🔓 still unlocked - \`/lock\` when done

This is non-negotiable: every reply while unlocked ends with that line so Shawn doesn't forget to relock. If you skip it, the bot is less safe. If a destructive action is part of the task (rm, drop, send, push, force, money, public-post), name what you're about to do BEFORE doing it and pause for a confirmation if you're not sure.`;
