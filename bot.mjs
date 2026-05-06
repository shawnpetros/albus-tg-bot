#!/usr/bin/env node
// argyle-tg-bot — Telegram surface for Argyle.
// Long-polls Telegram getUpdates, spawns `claude -p` per message with OpenMemory MCP
// access and the Argyle persona, sends the response back.
//
// Stateless per-message. Mem0 is the only persistence across messages.
// Authorized for a single chat_id (env: ARGYLE_BOT_CHAT_ID).

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.ARGYLE_BOT_TOKEN;
const CHAT_ID = process.env.ARGYLE_BOT_CHAT_ID;
const PERSONA = readFileSync(resolve(HERE, 'persona.md'), 'utf8');
const MCP_CONFIG = resolve(HERE, 'mcp-config.json');
const TG_API = `https://api.telegram.org/bot${TOKEN}`;
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const TG_MSG_MAX = 4000;

if (!TOKEN || !CHAT_ID) {
  console.error('ARGYLE_BOT_TOKEN and ARGYLE_BOT_CHAT_ID required in env. source ~/.exports');
  process.exit(1);
}

let offset = 0;
let busy = false;

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
  try { await tg('sendChatAction', { chat_id: Number(CHAT_ID), action: 'typing' }); }
  catch { /* swallow; typing indicator is non-critical */ }
}

function spawnArgyle(input) {
  return new Promise((resolveP, rejectP) => {
    const args = [
      '-p',
      '--setting-sources', 'project,local',
      '--dangerously-skip-permissions',
      '--mcp-config', MCP_CONFIG,
      '--append-system-prompt', PERSONA,
      '--output-format', 'text',
    ];
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectP(new Error(`turn timed out after ${TURN_TIMEOUT_MS / 1000}s`));
    }, TURN_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); rejectP(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectP(new Error(`claude exited ${code}: ${stderr.slice(-500) || 'no stderr'}`));
      } else {
        resolveP(stdout.trim());
      }
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  if (String(msg.chat.id) !== String(CHAT_ID)) {
    console.warn(`unauthorized chat_id=${msg.chat.id}, ignoring`);
    return;
  }

  console.log(`[${new Date().toISOString()}] ${msg.from?.first_name || 'user'}: ${msg.text.slice(0, 80)}`);
  if (busy) {
    await sendMessage('still working on the previous turn, queue this and try again in a moment');
    return;
  }
  busy = true;
  try {
    await sendTyping();
    const reply = await spawnArgyle(msg.text);
    await sendMessage(reply || '(no reply)');
    console.log(`  -> sent ${reply.length} chars`);
  } catch (e) {
    console.error('turn failed:', e.message);
    await sendMessage(`bot error: ${e.message}`);
  } finally {
    busy = false;
  }
}

async function pollLoop() {
  console.log(`argyle-tg-bot started, watching chat_id=${CHAT_ID}`);
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
