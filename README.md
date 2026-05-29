# albus-tg-bot

> A Telegram surface for a fully-agentic Claude Code session. Voice in, voice out, attachments both ways, persistent memory across messages, and a watchdog that catches the moments when polling pretends it's alive but isn't.

Named after Dumbledore. Built so I could ask my laptop to do things from the couch and have it actually do them.

---

## What it actually is

A `bun run bot.ts` daemon that long-polls Telegram, spawns `claude -p` per message with the Honcho MCP attached and a senior-wizard persona injected, and pipes the response back. The bot is the transport; Claude Code is the brain. The interesting bit is the lap around that.

```
Telegram  →  bot (polling)  →  claude -p --resume <session>  →  reply
                  │                       │
                  │                       ├─ MCP: honcho (long-term memory)
                  ├─ download photos / docs / voice
                  ├─ transcribe voice via ElevenLabs Scribe
                  ├─ render Markdown → Telegram HTML
                  ├─ stream tool-use events into a wizarding scratchpad
                  ├─ flush per-turn outbox (reply.md, reply.mp3, etc.)
                  └─ write heartbeat for the watchdog
```

---

## Features

**Two-way attachments.** Inbound photos, PDFs, voice notes, audio, video, video notes. The bot drops the file on disk and references the absolute path in the prompt so Claude can `Read` it. Outbound: Claude writes any file into the per-turn outbox dir, the bot scans and sends each via `sendDocument` / `sendPhoto` / `sendVoice` based on extension. Optional sibling `<file>.caption.txt` provides the caption.

**Voice both directions.** Inbound voice memos transcribe via ElevenLabs Scribe; Claude sees `[voice transcript: ...]` and reasons on text. Outbound: a tiny `scripts/tts.ts` CLI generates an mp3 in the cloned voice of your choice and drops it in the outbox. Round-trip Telegram voice works because `sendVoice` accepts the .mp3 cleanly.

**Markdown that actually renders.** Replies go through a CommonMark → Telegram HTML converter so `**bold**`, `*italic*`, fenced ` ```code``` `, `# headings`, `- bullets`, and `[links](url)` all show up the way they should. Bullets become `•` because Telegram has no list element. Falls back to plain text if the HTML parser ever chokes.

**Lock / unlock modes.** Default mode is locked: Read, Grep, Glob, WebFetch, WebSearch, Task, TodoWrite, and Honcho recall only (`mcp__honcho__search`/`chat`/`get_context`). No Bash, no Edit, no Write, no memory writes. `/unlock` opens the full toolbox. `/lock` or `/relock` closes it again. The persona enforces the etiquette; the bot enforces the surface.

**Session continuity.** Each message threads through `claude -p --resume <session_id>`. The session id persists across daemon restarts (launchd respawn, machine reboot) - if the JSONL is still on disk, you pick up where you left off.

**Self-healing.** A separate launchd watchdog reads `~/.albus-tg-bot/heartbeat` every 60s. The bot stamps that file on every successful `getUpdates` round-trip; if it goes stale (>90s old), the watchdog runs `launchctl kickstart -k`. Catches the "alive but wedged" case that `KeepAlive: { Crashed: true }` cannot.

**Streaming tool-use scratchpad.** When Claude starts pulling tools (Read, Bash, Grep, MCP calls), a single Telegram message opens, edits in place per tool fired, and deletes itself when the final reply lands. Each tool gets a wizarding line: `🧪 brewing`, `📜 scribing`, `🔍 scrying`, `🦉 dispatching an owl`. Failed turns leave the scratchpad with a `💥 spell fizzled` line so postmortems survive.

---

## Architecture

```
albus-tg-bot/
├── bot.ts                 # entry: loads persona, ensures dirs, calls startBot()
├── lib/
│   ├── config.ts          # env vars, paths, mode prompts, constants
│   ├── format.ts          # CommonMark → Telegram HTML (pure, no I/O)
│   ├── state.ts           # session.json + state.json read/write
│   ├── heartbeat.ts       # writeHeartbeat() for the watchdog
│   ├── telegram.ts        # tg/sendMessage/sendAttachment/sendTyping/downloadFile
│   ├── outbox.ts          # per-turn attachment dir flush (deps injected)
│   ├── scratchpad.ts      # tool-use scratchpad lifecycle (deps injected)
│   ├── elevenlabs.ts      # TTS + STT wrappers
│   ├── claude.ts          # spawnAlbus subprocess + stream-json parser
│   ├── slash.ts           # /reset /lock /unlock /session /status /help router
│   └── poll.ts            # handleUpdate + the main poll loop
├── scripts/
│   ├── tts.ts             # bun CLI: text → mp3 via ElevenLabs
│   └── register-commands.sh   # one-shot: register slash commands with Telegram
├── launchd/
│   ├── com.example.albus-tg-bot.plist    # template → com.<host>.albus-tg-bot.plist
│   ├── com.example.albus-watchdog.plist  # template → com.<host>.albus-watchdog.plist
│   ├── run.example.sh     # template → run.sh: sources your secrets, execs bun run bot.ts
│   └── watchdog.example.sh # template → watchdog.sh: stat-checks heartbeat mtime
├── test/                  # 60+ unit + integration tests, bun test
├── persona.md             # the Albus voice + behavioral rules
├── mcp-config.example.json # Honcho MCP template (placeholders)
├── tsconfig.json
├── Dockerfile             # for hermetic test runs
└── docker-compose.yml     # `docker compose run --rm test`
```

Module graph has zero cycles. `outbox` and `scratchpad` take their telegram dependencies via injection so they're testable without a real bot. Pure helpers (`format`, `state`, `heartbeat`) have zero imports beyond core.

---

## Setup

Requires Bun (`curl -fsSL https://bun.sh/install | bash`), Claude Code CLI, and a Telegram bot token from [@BotFather](https://t.me/BotFather).

```bash
git clone git@github.com:shawnpetros/albus-tg-bot.git
cd albus-tg-bot
bun install

# Required env:
export ALBUS_BOT_TOKEN="<from BotFather>"
export ALBUS_BOT_CHAT_ID="<your numeric chat id>"

# Optional (enables voice):
export ELEVENLABS_API_KEY="<your key>"
export ALBUS_VOICE_ID="<voice id from elevenlabs.io>"

# Run it:
bun run bot.ts
```

For permanent running, the `launchd/` directory ships `.example` versions of both plists and the run/watchdog shell scripts. The rendered host-specific versions are `.gitignore`d. Set yours up once:

```bash
cd launchd
cp com.example.albus-tg-bot.plist   com.<YOUR_DOMAIN>.albus-tg-bot.plist
cp com.example.albus-watchdog.plist com.<YOUR_DOMAIN>.albus-watchdog.plist
cp run.example.sh                   run.sh
cp watchdog.example.sh              watchdog.sh
# edit the four files: replace /Users/YOUR_USERNAME and com.YOUR_DOMAIN
cp com.<YOUR_DOMAIN>.*.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.<YOUR_DOMAIN>.albus-tg-bot.plist
launchctl load ~/Library/LaunchAgents/com.<YOUR_DOMAIN>.albus-watchdog.plist
```

---

## Per-host configuration

The repo ships generic defaults; per-host config lives outside the working tree so cloners aren't inheriting someone else's setup. Layout:

| What | Where | Notes |
|---|---|---|
| Base persona (ships in repo) | `persona.md` | Generic senior-wizard register, brevity + format rules, attachment/outbox/voice mechanics. No operator-specific anything. |
| Persona overlay (your local) | `~/.config/albus/persona.local.md` | Optional. If present, the bot appends it to the base at spawn time. Put your name, your projects, your memory-substrate setup, your voice ids, anything operator-specific here. |
| MCP servers (ships in repo) | `mcp-config.example.json` | Template with placeholders. |
| MCP servers (your local) | `~/.config/albus/mcp-config.json` | Resolution order: env `ALBUS_MCP_CONFIG` → `~/.config/albus/mcp-config.json` → repo `.example.json`. |
| Launchd plists, shell wrappers | `launchd/*.example.*` (repo) → host-specific copies (gitignored) | See "Setup" above. |

`~/.config/albus/` is created on first need; the bot doesn't fail without it (overlay and per-host mcp-config are both optional).

---

## Test it

```bash
bun test               # all 60+ tests
bun test format        # one file
bunx tsc --noEmit      # type-check pass

docker compose run --rm test       # hermetic, no host state touched
docker compose run --rm typecheck  # tsc in a container
```

---

## Persona

`persona.md` injects on every spawn via `claude -p --append-system-prompt`. It defines:

- The voice: senior-wizard register, no em dashes, no AI-slop vocabulary, real verbs, no employee-handbook energy
- Brevity rules: 3-6 lines / ~500 chars inline; longer answers go to `reply.md` in the outbox
- The lock/unlock contract: in locked mode, the persona enforces what the tool allowlist denies
- File handling: how to interpret inbound `[screenshot at /path]` / `[document at /path]` / `[voice transcript: ...]` markers
- Voice replies: the TTS CLI invocation pattern (only available unlocked because it needs Bash + Write)

The persona file is hot-reloaded on every spawn, so editing it takes effect on the next message without restarting the daemon.

---

## Slash commands

| Command | What it does |
|---|---|
| `/reset` or `/new` | Clear the Claude session; next message starts a fresh thread (long-term memory unaffected) |
| `/unlock` | Switch to full tools (Bash, Edit, Write, memory writes). Replies append a "still unlocked" reminder. |
| `/lock` or `/relock` | Back to read-only safe mode |
| `/session` or `/status` | Print current session id and mode |
| `/help` | List commands |

---

## Why this exists

Three reasons:

1. **A Claude agent on my phone is materially more useful than a Claude agent in a terminal I can't reach from the couch.** Couch-coding is the headline use case.
2. **The interesting work isn't Telegram, it's the per-turn outbox + persona injection + lock contract.** That pattern generalizes to Discord, Slack, voice, anywhere with a message bus.
3. **It's the smallest possible test bed for the "lots of agents in one room" architecture.** Same skeleton; swap Telegram for Discord and you've got Albus + Penny + Matilda able to share a channel.

---

## Status

Personal infrastructure. MIT-friendly if anyone forks it; not currently soliciting issues. The Telegram bot username it talks to is private to one chat id by design.
