# argyle-tg-bot

Telegram surface for Argyle. Message `@argyle_cc_bot` on Telegram, get an Argyle reply with full Mem0 access.

## What it is

- Single Node script that long-polls Telegram `getUpdates`.
- For each authorized message, spawns `claude -p` with:
  - `--setting-sources project,local` (skip user-scope hooks/skills bloat)
  - `--dangerously-skip-permissions` (full agent on the host machine)
  - `--mcp-config mcp-config.json` (only OpenMemory MCP, nothing else)
  - `--append-system-prompt persona.md` (Argyle voice + memory instructions)
- Captures stdout, sends back via Telegram `sendMessage`. Splits at 4000 chars.
- Stateless per-message. Mem0 is the only persistence.

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
