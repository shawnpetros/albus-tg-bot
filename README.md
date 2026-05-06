# argyle-tg-bot

Telegram surface for Argyle. Message `@argyle_cc_bot` on Telegram, get an Argyle reply with full Mem0 access.

## What it is

- Single Node script that long-polls Telegram `getUpdates`.
- For each authorized message, spawns `claude -p` with:
  - `--setting-sources project,local` (skip user-scope hooks/skills bloat)
  - `--dangerously-skip-permissions` (full agent on the host machine)
  - `--mcp-config mcp-config.json` (only OpenMemory MCP, nothing else)
  - `--append-system-prompt persona.md` (Argyle voice + memory instructions)
  - `--output-format json` (so the harness can parse `result` + `session_id`)
  - `--resume <session_id>` when a previous session exists (continuity)
- Captures stdout JSON, extracts `.result` for the reply, sends via Telegram `sendMessage`. Splits at 4000 chars.

## Session continuity

The bot persists the Claude session id to `~/.argyle-tg-bot/session.json` between turns. This survives daemon restarts (launchd respawn, machine reboot) — if the JSONL is still on disk, the session resumes.

Two layers of memory:
- **Short-term** = session continuity via `--resume`. Last several turns are in Claude's immediate context.
- **Long-term** = Mem0 / OpenMemory MCP. Cross-session, cross-agent (Argyle, Penny, etc.).

Slash commands:
- `/reset` or `/new` — clear the session, next message starts a fresh thread (Mem0 unaffected).
- `/session` — print current session id.
- `/help` — list commands.

## Setup

```bash
# Required env (already in ~/.exports if you've run that path):
export ARGYLE_BOT_TOKEN=8644288223:...
export ARGYLE_BOT_CHAT_ID=8442348137

# Install (no deps; Node 18+ has native fetch):
cd ~/projects/argyle-tg-bot
node bot.mjs
```

## Files

- `bot.mjs` — main loop
- `persona.md` — Argyle persona injected via `--append-system-prompt`
- `mcp-config.json` — OpenMemory MCP only
- `package.json` — no deps, `npm start` and `npm run dev` shortcuts

## Authorization

Only messages from `ARGYLE_BOT_CHAT_ID` are processed. Other chat_ids are logged and ignored.

## Limits

- One in-flight turn at a time. Concurrent messages get a "still working" reply and are dropped (not queued in v1).
- 5-minute timeout per turn.
- 4000-char Telegram message split.

## Running as a service

For now, run it in a tmux pane or a foreground terminal. If it earns its keep, wrap it in a launchd plist. Pattern matches `~/projects/smithy/launchd/`.

## Adding more personas

The persona pattern is portable: drop another markdown file with frontmatter (name, agent_command, model_hint) + body. Variants might include `penny.md` (different voice for meeting capture), `pm.md` (project manager mode for Linear-heavy days), etc. The bot script can grow a `--persona <path>` arg to swap.
