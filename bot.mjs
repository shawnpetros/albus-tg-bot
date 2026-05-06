#!/usr/bin/env node
// argyle-tg-bot — Telegram surface for Argyle.
// Long-polls Telegram getUpdates, spawns `claude -p` per message with OpenMemory MCP
// access and the Argyle persona, sends the response back.
//
// Session-continuous: captures `session_id` from each `claude -p --output-format json`
// response, persists it to ~/.argyle-tg-bot/session.json, and passes --resume on
// subsequent calls so Claude itself remembers the conversation. Mem0 still serves
// as the long-term cross-session substrate; the session_id is the short-term
// thread-of-thought.
//
// Authorized for a single chat_id (env: ARGYLE_BOT_CHAT_ID).
// Slash commands: /reset (start a fresh session), /session (show current id).

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.ARGYLE_BOT_TOKEN;
const CHAT_ID = process.env.ARGYLE_BOT_CHAT_ID;
const PERSONA = readFileSync(resolve(HERE, 'persona.md'), 'utf8');
const MCP_CONFIG = resolve(HERE, 'mcp-config.json');
const TG_API = `https://api.telegram.org/bot${TOKEN}`;
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const TG_MSG_MAX = 4000;

// Session state lives outside the repo so re-deploys don't blow it away.
const STATE_DIR = `${homedir()}/.argyle-tg-bot`;
const SESSION_FILE = `${STATE_DIR}/session.json`;

if (!TOKEN || !CHAT_ID) {
  console.error('ARGYLE_BOT_TOKEN and ARGYLE_BOT_CHAT_ID required in env. source ~/.exports');
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

function spawnArgyle(input, sessionId) {
  return new Promise((resolveP, rejectP) => {
    const args = [
      '-p',
      '--setting-sources', 'project,local',
      '--dangerously-skip-permissions',
      '--mcp-config', MCP_CONFIG,
      '--append-system-prompt', PERSONA,
      '--output-format', 'json',
    ];
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectP(new Error(`turn timed out after ${TURN_TIMEOUT_MS / 1000}s`));
    }, TURN_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
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
      // --output-format json returns one JSON object on stdout.
      try {
        const parsed = JSON.parse(stdout.trim());
        resolveP({
          reply: parsed.result || '',
          sessionId: parsed.session_id || null,
          cost: parsed.total_cost_usd || 0,
          turns: parsed.num_turns || 0,
        });
      } catch (e) {
        rejectP(new Error(`failed to parse claude json: ${e.message}; stdout head: ${stdout.slice(0, 300)}`));
      }
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
    case '/session': {
      await sendMessage(
        currentSessionId
          ? `Current session: ${currentSessionId}`
          : 'No active session. Next message will start one.'
      );
      return true;
    }
    case '/help': {
      await sendMessage(
        'Argyle bot commands:\n' +
        '/reset or /new — start a fresh session (clears short-term context, Mem0 stays)\n' +
        '/session — show current session id\n' +
        '/help — this message\n\n' +
        'Anything else: I respond as Argyle with full agency on the host machine.'
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
  try {
    await sendTyping();
    let result;
    try {
      result = await spawnArgyle(msg.text, currentSessionId);
    } catch (e) {
      // If --resume failed because the session is stale or the JSONL was deleted,
      // retry with a fresh session. Heuristic: error mentions "session" or "resume".
      const looksLikeSessionLoss = currentSessionId && /session|resume|jsonl/i.test(e.message);
      if (looksLikeSessionLoss) {
        console.warn(`resume failed for ${currentSessionId}, starting fresh: ${e.message}`);
        currentSessionId = null;
        saveSession(null);
        result = await spawnArgyle(msg.text, null);
      } else {
        throw e;
      }
    }
    if (result.sessionId && result.sessionId !== currentSessionId) {
      currentSessionId = result.sessionId;
      saveSession(currentSessionId);
    }
    await sendMessage(result.reply || '(no reply)');
    console.log(
      `  -> sent ${result.reply.length} chars, session=${result.sessionId?.slice(0, 8)}, ` +
      `turns=${result.turns}, cost=$${result.cost.toFixed(4)}`
    );
  } catch (e) {
    console.error('turn failed:', e.message);
    await sendMessage(`bot error: ${e.message}`);
  } finally {
    busy = false;
  }
}

async function pollLoop() {
  console.log(
    `argyle-tg-bot started, watching chat_id=${CHAT_ID}, ` +
    `session=${currentSessionId ? currentSessionId.slice(0, 8) + '...' : '(none, will start fresh on first message)'}`
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
