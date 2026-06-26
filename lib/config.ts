// Centralised configuration: env vars, paths, constants, mode-context prompts.
// No I/O at module load beyond env reads; everything else is exported and
// consumed lazily by other modules. The required-env check fails fast at
// module load so the bot dies in the launchd log rather than mid-handle.

import { existsSync } from "node:fs";
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

// Default model when no per-session override is set via /model. Threaded into
// every `claude -p --model` call so the bot doesn't drift to whatever the CLI
// default happens to be. /model still overrides this per session. Override the
// baseline via env.
export const DEFAULT_MODEL =
  process.env.ALBUS_DEFAULT_MODEL || "claude-opus-4-8";

// When a turn's prompt-token count crosses this, the bot schedules a headless
// /compact pass before the next pending user message. Keeps the session from
// drifting toward the model's context ceiling. Override via env.
export const COMPACT_TOKEN_THRESHOLD =
  Number(process.env.ALBUS_COMPACT_TOKEN_THRESHOLD) || 120_000;

// Cooldown backstop for compaction: even when context is at/over the
// threshold, don't enqueue another /compact until at least this many turns
// have elapsed since the last one. Stops thrashing near the boundary.
// Override via env.
export const COMPACT_COOLDOWN_TURNS =
  Number(process.env.ALBUS_COMPACT_COOLDOWN_TURNS) || 5;

// User-config dir for overrides and local-only settings. Persona overlay
// (persona.local.md) and per-host mcp-config.json live here, gitignored,
// so cloners can configure without touching the repo.
export const USER_CONFIG_DIR =
  process.env.ALBUS_CONFIG_DIR || `${homedir()}/.config/albus`;

// Base persona ships in the repo. If ~/.config/albus/persona.local.md
// exists, the bot appends it to the base at spawn time (handled in bot.ts).
export const PERSONA_PATH = resolve(PROJECT_ROOT, "persona.md");
export const PERSONA_LOCAL_PATH = `${USER_CONFIG_DIR}/persona.local.md`;

// MCP config resolution: env var → user-config dir → repo example.
// The example file is committed for cloners to see the shape; the real
// per-host config lives in ~/.config/albus/ (gitignored).
function resolveMcpConfig(): string {
  const fromEnv = process.env.ALBUS_MCP_CONFIG;
  if (fromEnv) return fromEnv;
  const fromUserConfig = `${USER_CONFIG_DIR}/mcp-config.json`;
  if (existsSync(fromUserConfig)) return fromUserConfig;
  return resolve(PROJECT_ROOT, "mcp-config.example.json");
}
export const MCP_CONFIG = resolveMcpConfig();

// Per-day spend guardrail. When the day's accumulated Claude cost crosses
// this (USD), the bot posts a one-time warning. Soft cap: turns keep
// processing (see poll.ts), the warning just fires once per day. Override
// via env.
export const DAILY_COST_LIMIT_USD = Number(process.env.ALBUS_DAILY_COST_USD) || 20;

// Telemetry footer: append a context/cost status line to every reply. Default
// ON. Set ALBUS_SHOW_TELEMETRY=false (or 0) to mute the cost/context numbers.
// The lock-state reminder still shows when unlocked regardless. Prep for the
// raw-API-cost era: surface spend per pass / session / day at a glance.
export const SHOW_TELEMETRY =
  !["false", "0", "off", "no"].includes(
    (process.env.ALBUS_SHOW_TELEMETRY ?? "true").toLowerCase()
  );

// State paths
export const STATE_DIR = `${homedir()}/.albus-tg-bot`;
export const SESSION_FILE = `${STATE_DIR}/session.json`;
export const STATE_FILE = `${STATE_DIR}/state.json`;
// Daily-spend ledger, sibling to STATE_FILE. Small {date, cost_usd, warned}
// record that rolls over when the calendar date changes.
export const DAILY_COST_FILE = `${STATE_DIR}/daily-cost.json`;
export const PHOTOS_DIR = `${STATE_DIR}/photos`;
export const OUTBOX_DIR = `${STATE_DIR}/outbox`;

// Heartbeat for the watchdog. Bot writes this file on every poll round-trip;
// the watchdog launchd job restarts the bot if mtime exceeds HEARTBEAT_STALE_SECS.
export const HEARTBEAT_FILE = `${STATE_DIR}/heartbeat`;
export const HEARTBEAT_STALE_SECS = 90;

// ElevenLabs voice IO (V2). Both env vars are OPTIONAL: when unset, voice
// transcription is skipped (voice memos still get downloaded + referenced
// by path) and the TTS CLI refuses to run. Bot starts fine without either.
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
export const ALBUS_VOICE_ID = process.env.ALBUS_VOICE_ID;

// --- Voice aside fast-path (see specs/2026-05-29-voice-memo-fast-path) ---
// Kill switch for the voice ack + spoken-TLDR fast-path. Default on.
export const VOICE_ACK_ENABLED =
  (process.env.ALBUS_VOICE_ACK_ENABLED ?? "true").toLowerCase() !== "false";
// Fixed fast model for both asides, independent of the session /model setting.
export const VOICE_ASIDE_MODEL =
  process.env.ALBUS_VOICE_ASIDE_MODEL || "claude-haiku-4-5";
// Spoken TL;DR char cap (~30s of speech). Replaces the old 1500 truncation
// for the summary path.
export const VOICE_TLDR_MAX_CHARS =
  Number(process.env.ALBUS_VOICE_TLDR_MAX_CHARS) || 600;
// Hard timeout for an aside call. Asides are best-effort and must never hang.
export const QUICK_TIMEOUT_MS =
  Number(process.env.ALBUS_QUICK_TIMEOUT_MS) || 30_000;
// The few-shot personality card both asides load as their system prompt.
export const PERSONA_VOICE_PATH = resolve(PROJECT_ROOT, "persona-voice.md");

// --- Agent-native Telegram surface (reactions + reply streaming) ---
// Message reactions as turn status: 👀 on receive, 👍 on success, 😱 on
// failure. Cheap, very "agent-native". Default on; set ALBUS_REACTIONS=false
// to mute. The setMessageReaction emoji must come from Telegram's fixed set.
export const REACTIONS_ENABLED =
  (process.env.ALBUS_REACTIONS ?? "true").toLowerCase() !== "false";

// Live reply streaming: while the model writes, edit the existing live message
// (the same one the scratchpad uses for tool progress) with a rolling preview
// of the reply as it forms, then finalize with the clean formatted version.
// Default on; set ALBUS_STREAM_REPLY=false to disable. The text deltas already
// flow from `claude -p --include-partial-messages`; this just surfaces them.
export const STREAM_REPLY_ENABLED =
  (process.env.ALBUS_STREAM_REPLY ?? "true").toLowerCase() !== "false";

// Don't open a streaming preview for short replies. A one-liner that arrives
// whole is snappier than open→edit→delete→resend flicker. Only start the live
// preview once the accumulated reply text crosses this many characters.
export const STREAM_MIN_CHARS =
  Number(process.env.ALBUS_STREAM_MIN_CHARS) || 240;

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
  "mcp__honcho__search",
  "mcp__honcho__chat",
  "mcp__honcho__get_context",
].join(",");

export const LOCKED_MODE_PROMPT = `

--- Mode context (auto-injected by the bot harness, do not include in reply) ---
You are currently in **🔒 LOCKED / read-only safe mode**.

Available tools: Read, Grep, Glob, WebFetch, WebSearch, Task, TodoWrite, Honcho (your long-term memory) **read-only** via \`mcp__honcho__search\`, \`mcp__honcho__chat\`, and \`mcp__honcho__get_context\` (recall only).
Disabled tools: Bash, Edit, Write, NotebookEdit, Honcho **writes** (\`mcp__honcho__create_conclusion\`, \`mcp__honcho__delete_conclusion\`, \`mcp__honcho__set_config\` — no memory writes either), anything that mutates the host or the substrate.

If the operator asks for an action that requires a disabled tool (run a command, edit a file, delete memory, push code, send a message, etc.), DO NOT try to use it. Reply with what you'd do and tell them to send \`/unlock\` first. Then they can re-send the original ask.

Don't add any mode footer to your reply. The bot harness handles UI affordances; your job is just to respect the read-only boundary.`;

export const UNLOCKED_MODE_PROMPT = `

--- Mode context (auto-injected by the bot harness, do not include in reply) ---
You are currently in **🔓 UNLOCKED mode**. Full tools available: Bash, Edit, Write, the full Honcho memory surface (\`mcp__honcho__*\`, including writes), the works. Use \`--dangerously-skip-permissions\`-equivalent agency on the host machine.

**Do NOT append a lock/unlock footer yourself.** The bot harness now appends a status line (lock state, context fill, cost) to the end of every reply automatically. Adding your own would duplicate it. Just answer and stop.

If a destructive action is part of the task (rm, drop, send, push, force, money, public-post), name what you're about to do BEFORE doing it and pause for a confirmation if you're not sure.`;
