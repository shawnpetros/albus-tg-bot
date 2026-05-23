#!/usr/bin/env node
// albus-tg-bot — Telegram surface for Albus.
// Long-polls Telegram getUpdates, spawns `claude -p` per message with OpenMemory MCP
// access and the Albus persona, sends the response back.
//
// Session-continuous: captures `session_id` from each `claude -p --output-format json`
// response, persists it to ~/.albus-tg-bot/session.json, and passes --resume on
// subsequent calls so Claude itself remembers the conversation. Mem0 still serves
// as the long-term cross-session substrate; the session_id is the short-term
// thread-of-thought.
//
// Authorized for a single chat_id (env: ALBUS_BOT_CHAT_ID).
// Slash commands: /reset (start a fresh session), /session (show current id).

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.ALBUS_BOT_TOKEN;
const CHAT_ID = process.env.ALBUS_BOT_CHAT_ID;
const PERSONA = readFileSync(resolve(HERE, 'persona.md'), 'utf8');
const MCP_CONFIG = resolve(HERE, 'mcp-config.json');
const TG_API = `https://api.telegram.org/bot${TOKEN}`;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const TG_MSG_MAX = 4000;

// Session state lives outside the repo so re-deploys don't blow it away.
const STATE_DIR = `${homedir()}/.albus-tg-bot`;
const SESSION_FILE = `${STATE_DIR}/session.json`;
const STATE_FILE = `${STATE_DIR}/state.json`;

// Locked-mode tool allowlist: pure read. Excludes anything that mutates host,
// substrate, or external state. Memory writes (add_memories, delete_memories)
// require /unlock so the substrate can't drift behind your back. TodoWrite is
// in-context-only, no external side effects, kept for agent planning ergonomics.
// Listed tools auto-approve; un-listed tools prompt and prompts deny in -p mode.
const LOCKED_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
  'mcp__openmemory__search_memory',
  'mcp__openmemory__list_memories',
].join(',');

// System prompt fragments appended per mode so Albus knows what's active and
// can self-enforce (read-only awareness in locked mode, lock-reminder in unlocked).
const LOCKED_MODE_PROMPT = `

--- Mode context (auto-injected by the bot harness, do not include in reply) ---
You are currently in **🔒 LOCKED / read-only safe mode**.

Available tools: Read, Grep, Glob, WebFetch, WebSearch, Task, TodoWrite, openmemory **search and list only** (read-only memory access).
Disabled tools: Bash, Edit, Write, NotebookEdit, openmemory **add/delete** (no memory writes either), anything that mutates the host or the substrate.

If Shawn asks for an action that requires a disabled tool (run a command, edit a file, delete memory, push code, send a message, etc.), DO NOT try to use it. Reply with what you'd do and tell him to send \`/unlock\` first. Then he can re-send the original ask.

Don't add any mode footer to your reply. The bot harness handles UI affordances; your job is just to respect the read-only boundary.`;

const UNLOCKED_MODE_PROMPT = `

--- Mode context (auto-injected by the bot harness, do not include in reply) ---
You are currently in **🔓 UNLOCKED mode**. Full tools available: Bash, Edit, Write, openmemory full surface, the works. Use \`--dangerously-skip-permissions\`-equivalent agency on the host machine.

**Always append this exact line as the LAST line of your reply** (after a blank line, no other formatting):

🔓 still unlocked — \`/lock\` when done

This is non-negotiable: every reply while unlocked ends with that line so Shawn doesn't forget to relock. If you skip it, the bot is less safe. If a destructive action is part of the task (rm, drop, send, push, force, money, public-post), name what you're about to do BEFORE doing it and pause for a confirmation if you're not sure.`;

if (!TOKEN || !CHAT_ID) {
  console.error('ALBUS_BOT_TOKEN and ALBUS_BOT_CHAT_ID required in env. source ~/.exports');
  process.exit(1);
}

mkdirSync(STATE_DIR, { recursive: true });

let offset = 0;
let busy = false;

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

function loadSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    return data.session_id || null;
  } catch {
    return null;
  }
}

function saveSession(id) {
  if (id === null) {
    // Use empty file so existsSync still true; cleaner than unlink for atomic-ish behavior.
    writeFileSync(SESSION_FILE, JSON.stringify({ session_id: null, reset_at: new Date().toISOString() }, null, 2));
    return;
  }
  writeFileSync(SESSION_FILE, JSON.stringify({ session_id: id, updated_at: new Date().toISOString() }, null, 2));
}

let currentSessionId = loadSession();

function loadState() {
  if (!existsSync(STATE_FILE)) return { unlocked: false };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { unlocked: false };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let currentState = loadState();

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

async function tg(method, body) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`tg ${method}: ${data.description || 'unknown error'}`);
  return data.result;
}

async function sendMessage(text) {
  if (!text) text = '(empty response)';
  for (let i = 0; i < text.length; i += TG_MSG_MAX) {
    await tg('sendMessage', { chat_id: Number(CHAT_ID), text: text.slice(i, i + TG_MSG_MAX) });
  }
}

async function sendTyping() {
  try {
    await tg('sendChatAction', { chat_id: Number(CHAT_ID), action: 'typing' });
  } catch {
    /* swallow; typing indicator is non-critical */
  }
}

// ---------------------------------------------------------------------------
// Claude subprocess
// ---------------------------------------------------------------------------

// Wizarding lexicon for tool calls. Each tool resolves to one emoji + one short
// verb phrase, with the live args summarised. Bash uses Claude's own description
// field where present (same source openclaw uses).
function describeToolCall(name, args) {
  const basename = (p) => (typeof p === 'string' && p ? p.split('/').pop() : '');
  const clip = (s, n = 60) => (typeof s === 'string' ? s.slice(0, n) : '');
  switch (name) {
    case 'Bash':
      return `🧪 brewing: ${clip(args.description || args.command)}`;
    case 'Edit':
      return `✍️ inscribing ${basename(args.file_path)}`;
    case 'Write':
      return `📜 scribing ${basename(args.file_path)}`;
    case 'Read':
      return `📖 perusing ${basename(args.file_path)}`;
    case 'Grep':
      return `🔍 scrying for "${clip(args.pattern)}"`;
    case 'Glob':
      return `🗺️ surveying "${clip(args.pattern)}"`;
    case 'WebFetch': {
      let host = '';
      try { host = new URL(args.url).host; } catch { /* shrug */ }
      return host ? `🦉 dispatching an owl to ${host}` : '🦉 dispatching an owl';
    }
    case 'WebSearch':
      return `🔮 consulting the seeing-glass: "${clip(args.query)}"`;
    case 'Task':
      return `🪄 summoning: ${clip(args.description)}`;
    case 'TodoWrite':
      return `📋 charting ${(args.todos || []).length} todos`;
    default:
      if (name.startsWith('mcp__')) {
        const frag = name.replace(/^mcp__/, '').replace(/__/g, ' ');
        if (/add|save|write|create|set|update|delete/i.test(name)) {
          return `💾 committing: ${frag}`;
        }
        return `🔭 inquiring: ${frag}`;
      }
      return `⚙️ casting ${name}`;
  }
}

function spawnAlbus(input, sessionId, unlocked, onToolUse) {
  return new Promise((resolveP, rejectP) => {
    const fullPersona = PERSONA + (unlocked ? UNLOCKED_MODE_PROMPT : LOCKED_MODE_PROMPT);
    const args = [
      '-p',
      '--setting-sources', 'project,local',
      '--mcp-config', MCP_CONFIG,
      '--append-system-prompt', fullPersona,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    if (unlocked) {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--allowedTools', LOCKED_ALLOWED_TOOLS);
    }
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let finalResult = null;
    // Pending tool_use content blocks indexed by stream-event index. We accumulate
    // input_json_delta chunks until content_block_stop fires, then JSON-parse and
    // emit one onToolUse(name, args) call. Index resets per message_start.
    const pendingTools = new Map();

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectP(new Error(`turn timed out after ${TURN_TIMEOUT_MS / 1000}s`));
    }, TURN_TIMEOUT_MS);

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let evt;
      try { evt = JSON.parse(line); } catch { return; }

      if (evt.type === 'result') {
        finalResult = evt;
        return;
      }
      if (evt.type !== 'stream_event') return;
      const inner = evt.event || {};
      if (inner.type === 'message_start') {
        pendingTools.clear();
        return;
      }
      if (inner.type === 'content_block_start' && inner.content_block?.type === 'tool_use') {
        pendingTools.set(inner.index, { name: inner.content_block.name, json: '' });
        return;
      }
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'input_json_delta') {
        const p = pendingTools.get(inner.index);
        if (p) p.json += inner.delta.partial_json || '';
        return;
      }
      if (inner.type === 'content_block_stop') {
        const p = pendingTools.get(inner.index);
        if (!p) return;
        pendingTools.delete(inner.index);
        let parsedArgs = {};
        try { parsedArgs = p.json ? JSON.parse(p.json) : {}; } catch { /* leave empty */ }
        if (onToolUse) {
          try { onToolUse(p.name, parsedArgs); } catch (e) { console.warn('onToolUse threw:', e.message); }
        }
      }
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      rejectP(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectP(new Error(`claude exited ${code}: ${stderr.slice(-500) || 'no stderr'}`));
        return;
      }
      if (!finalResult) {
        rejectP(new Error(`no result event in stream; stderr tail: ${stderr.slice(-300) || '(empty)'}`));
        return;
      }
      resolveP({
        reply: finalResult.result || '',
        sessionId: finalResult.session_id || null,
        cost: finalResult.total_cost_usd || 0,
        turns: finalResult.num_turns || 0,
      });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

async function handleSlashCommand(text) {
  const cmd = text.split(/\s+/)[0].toLowerCase();
  switch (cmd) {
    case '/reset':
    case '/new': {
      const old = currentSessionId;
      currentSessionId = null;
      saveSession(null);
      await sendMessage(
        `Session cleared. Next message starts a fresh thread.\n` +
        (old ? `(was: ${old})` : '(no prior session)')
      );
      return true;
    }
    case '/unlock': {
      const wasUnlocked = currentState.unlocked;
      currentState = { ...currentState, unlocked: true, unlocked_at: new Date().toISOString() };
      saveState(currentState);
      await sendMessage(
        wasUnlocked
          ? '🔓 Already unlocked. Send `/lock` when done with the current task.'
          : '🔓 Unlocked. Full tools (Bash, Edit, Write, MCP writes) available on the next message.\n\nSend `/lock` or `/relock` to return to read-only safe mode.'
      );
      return true;
    }
    case '/lock':
    case '/relock': {
      const wasUnlocked = currentState.unlocked;
      currentState = { ...currentState, unlocked: false };
      delete currentState.unlocked_at;
      saveState(currentState);
      await sendMessage(
        wasUnlocked
          ? '🔒 Locked. Read-only safe mode active. (Read, Grep, WebFetch, WebSearch, openmemory search/list/add — no Bash/Edit/Write.)'
          : '🔒 Already locked. Read-only mode.'
      );
      return true;
    }
    case '/session':
    case '/status': {
      const sessionLine = currentSessionId
        ? `Session: ${currentSessionId}`
        : 'Session: none (next message starts one)';
      const modeLine = currentState.unlocked
        ? `Mode: 🔓 UNLOCKED (full tools, since ${currentState.unlocked_at || 'unknown'})`
        : 'Mode: 🔒 LOCKED (read-only safe mode)';
      await sendMessage(`${sessionLine}\n${modeLine}`);
      return true;
    }
    case '/help': {
      await sendMessage(
        'Albus bot commands:\n\n' +
        '🔒 / 🔓  mode switcher\n' +
        '/unlock — switch to full tools (Bash, Edit, Write, etc.). Replies will end with a "still unlocked — /lock when done" reminder.\n' +
        '/lock or /relock — switch back to read-only safe mode.\n\n' +
        '🧵  conversation\n' +
        '/reset or /new — clear the Claude session, fresh thread (Mem0 stays).\n' +
        '/session or /status — show current session id and mode.\n' +
        '/help — this message.\n\n' +
        'Default mode is locked. Read-only by design — anything that touches the host or substrate needs an /unlock first.'
      );
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Main per-message flow
// ---------------------------------------------------------------------------

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  if (String(msg.chat.id) !== String(CHAT_ID)) {
    console.warn(`unauthorized chat_id=${msg.chat.id}, ignoring`);
    return;
  }

  console.log(`[${new Date().toISOString()}] ${msg.from?.first_name || 'user'}: ${msg.text.slice(0, 80)}`);

  // Slash commands handled inline, no Claude spawn.
  if (msg.text.startsWith('/')) {
    if (await handleSlashCommand(msg.text)) return;
    // Unknown slash command -> falls through to Claude with the slash text intact.
  }

  if (busy) {
    await sendMessage('still working on the previous turn, queue this and try again in a moment');
    return;
  }
  busy = true;
  // Telegram chatAction (typing...) expires ~5s after each send. For the gap
  // before the first tool fires (and pure-text turns) we refresh it every 4s.
  // Once the scratchpad opens, edits subsume the activity signal but typing is
  // harmless on top of edits.
  const turnStartedAt = Date.now();
  await sendTyping();
  const typingTimer = setInterval(() => { sendTyping(); }, 4000);

  // Scratchpad state: a single message we open on the first tool call, append a
  // wizarding-flavoured line per tool, debounce-edit, and delete on result.
  // Pure-text turns never open a scratchpad.
  let scratchpadMessageId = null;
  const scratchpadLines = [];
  let scratchpadEditTimer = null;
  let scratchpadEditInFlight = false;
  let scratchpadDirty = false;

  const flushScratchpadEdit = async () => {
    if (!scratchpadMessageId || !scratchpadDirty || scratchpadEditInFlight) return;
    scratchpadEditInFlight = true;
    scratchpadDirty = false;
    // Cap at 20 lines visible, 3800 chars so we stay under Telegram's 4096 ceiling.
    const text = scratchpadLines.slice(-20).join('\n').slice(0, 3800);
    try {
      await tg('editMessageText', {
        chat_id: Number(CHAT_ID),
        message_id: scratchpadMessageId,
        text,
      });
    } catch (e) {
      console.warn('scratchpad edit failed:', e.message);
    } finally {
      scratchpadEditInFlight = false;
      // If more lines arrived during the in-flight edit, schedule a follow-up.
      if (scratchpadDirty) scheduleScratchpadEdit();
    }
  };

  const scheduleScratchpadEdit = () => {
    if (scratchpadEditTimer) return;
    scratchpadEditTimer = setTimeout(() => {
      scratchpadEditTimer = null;
      flushScratchpadEdit();
    }, 1500);
  };

  const closeScratchpad = async () => {
    if (scratchpadEditTimer) { clearTimeout(scratchpadEditTimer); scratchpadEditTimer = null; }
    if (!scratchpadMessageId) return;
    const id = scratchpadMessageId;
    scratchpadMessageId = null;
    try {
      await tg('deleteMessage', { chat_id: Number(CHAT_ID), message_id: id });
    } catch (e) {
      console.warn('scratchpad delete failed:', e.message);
    }
  };

  const onToolUse = (name, args) => {
    scratchpadLines.push(describeToolCall(name, args));
    scratchpadDirty = true;
    if (!scratchpadMessageId) {
      // Open lazily on first tool use. Fire-and-forget; the next debounced edit
      // will populate it. Don't await here, we're in a hot callback.
      (async () => {
        try {
          const sent = await tg('sendMessage', {
            chat_id: Number(CHAT_ID),
            text: '🪄 working...',
          });
          scratchpadMessageId = sent.message_id;
          scheduleScratchpadEdit();
        } catch (e) {
          console.warn('scratchpad open failed:', e.message);
        }
      })();
    } else {
      scheduleScratchpadEdit();
    }
  };

  try {
    let result;
    try {
      result = await spawnAlbus(msg.text, currentSessionId, currentState.unlocked, onToolUse);
    } catch (e) {
      // If --resume failed because the session is stale or the JSONL was deleted,
      // retry with a fresh session. Heuristic: error mentions "session" or "resume".
      const looksLikeSessionLoss = currentSessionId && /session|resume|jsonl/i.test(e.message);
      if (looksLikeSessionLoss) {
        console.warn(`resume failed for ${currentSessionId}, starting fresh: ${e.message}`);
        currentSessionId = null;
        saveSession(null);
        result = await spawnAlbus(msg.text, null, currentState.unlocked, onToolUse);
      } else {
        throw e;
      }
    }
    if (result.sessionId && result.sessionId !== currentSessionId) {
      currentSessionId = result.sessionId;
      saveSession(currentSessionId);
    }
    await closeScratchpad();
    await sendMessage(result.reply || '(no reply)');
    const elapsedS = ((Date.now() - turnStartedAt) / 1000).toFixed(1);
    console.log(
      `  -> sent ${result.reply.length} chars, session=${result.sessionId?.slice(0, 8)}, ` +
      `turns=${result.turns}, cost=$${result.cost.toFixed(4)}, ` +
      `mode=${currentState.unlocked ? 'unlocked' : 'locked'}, ` +
      `tools=${scratchpadLines.length}, elapsed=${elapsedS}s`
    );
  } catch (e) {
    console.error('turn failed:', e.message);
    // Leave the scratchpad visible on failure (with a fizzled tag) so diagnostics
    // survive. Edit in place if it was opened.
    if (scratchpadMessageId) {
      scratchpadLines.push(`💥 spell fizzled: ${e.message.slice(0, 200)}`);
      scratchpadDirty = true;
      await flushScratchpadEdit();
    } else {
      await sendMessage(`bot error: ${e.message}`);
    }
  } finally {
    clearInterval(typingTimer);
    busy = false;
  }
}

async function pollLoop() {
  console.log(
    `albus-tg-bot started, watching chat_id=${CHAT_ID}, ` +
    `session=${currentSessionId ? currentSessionId.slice(0, 8) + '...' : '(none, will start fresh on first message)'}, ` +
    `mode=${currentState.unlocked ? 'UNLOCKED' : 'LOCKED'}`
  );
  while (true) {
    try {
      const url = `${TG_API}/getUpdates?timeout=30&offset=${offset}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!data.ok) {
        console.error('getUpdates error:', data.description);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const update of data.result) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (e) {
      console.error('poll error:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

pollLoop().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
