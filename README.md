# tgclaude

> Telegram your Claude Code. A phone-native surface for a fully-agentic Claude Code session: voice in, voice out, attachments both ways, persistent sessions across messages, and a watchdog that catches the moments when polling pretends it's alive but isn't. Bring whatever persona you want.

Built so you can ask your machine to do things from the couch and have it actually do them.

---

## What it actually is

A `bun run bot.ts` daemon that long-polls Telegram, spawns `claude -p` per message with your MCP config attached and a pluggable persona injected, and pipes the response back. The bot is the transport; Claude Code is the brain. The interesting bit is the lap around that.

```
Telegram  →  bot (polling)  →  claude -p --resume <session>  →  reply
                  │                       │
                  │                       └─ your MCP servers (memory, whatever)
                  ├─ download photos / docs / voice
                  ├─ transcribe voice via ElevenLabs Scribe
                  ├─ render Markdown → Telegram HTML
                  ├─ stream tool-use events into a live scratchpad message
                  ├─ flush per-turn outbox (reply.md, reply.mp3, etc.)
                  └─ write heartbeat for the watchdog
```

---

## Features

**Two-way attachments.** Inbound photos, PDFs, voice notes, audio, video, video notes. The bot drops the file on disk and references the absolute path in the prompt so Claude can `Read` it. Outbound: Claude writes any file into the per-turn outbox dir, the bot scans and sends each via `sendDocument` / `sendPhoto` / `sendVoice` based on extension. Optional sibling `<file>.caption.txt` provides the caption.

**Voice both directions.** Inbound voice memos transcribe via ElevenLabs Scribe; Claude sees `[voice transcript: ...]` and reasons on text. Outbound: a tiny `scripts/tts.ts` CLI generates an mp3 in the cloned voice of your choice and drops it in the outbox. Round-trip Telegram voice works because `sendVoice` accepts the .mp3 cleanly.

**Markdown that actually renders.** Replies go through a CommonMark → Telegram HTML converter so `**bold**`, `*italic*`, fenced ` ```code``` `, `# headings`, `- bullets`, and `[links](url)` all show up the way they should. Bullets become `•` because Telegram has no list element. Falls back to plain text if the HTML parser ever chokes.

**Lock / unlock modes.** Default mode is locked: Read, Grep, Glob, WebFetch, WebSearch, Task, TodoWrite, plus any read-only MCP tools you allowlist via `TGCLAUDE_LOCKED_MCP_TOOLS`. No Bash, no Edit, no Write. `/unlock` opens the full toolbox. `/lock` or `/relock` closes it again. The persona enforces the etiquette; the bot enforces the surface.

**Session continuity.** Each message threads through `claude -p --resume <session_id>`. The session id persists across daemon restarts (launchd respawn, machine reboot) - if the JSONL is still on disk, you pick up where you left off.

**Self-healing.** A separate launchd watchdog reads `~/.tgclaude/heartbeat` every 60s. The bot stamps that file on every successful `getUpdates` round-trip; if it goes stale (>90s old), the watchdog runs `launchctl kickstart -k`. Catches the "alive but wedged" case that `KeepAlive: { Crashed: true }` cannot.

**Live scratchpad + reply streaming.** When Claude starts pulling tools, a single Telegram message opens, edits in place per tool fired (`⚙️ running`, `📖 reading`, `🔍 searching`), then hands over to a rolling preview of the reply as it streams, and finalizes with the clean formatted version. Failed turns leave the scratchpad with an error line so postmortems survive. Message reactions track turn status: 👀 received, 👍 done, 😱 failed.

---

## Architecture

```
tgclaude/
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
│   ├── claude.ts          # spawnClaude subprocess + stream-json parser
│   ├── aside.ts           # fast voice acks + spoken TL;DR (Haiku side-calls)
│   ├── telemetry.ts       # cost/context status line per reply
│   ├── slash.ts           # /reset /lock /unlock /session /status /help router
│   └── poll.ts            # handleUpdate + the main poll loop
├── scripts/
│   ├── tts.ts             # bun CLI: text → mp3 via ElevenLabs
│   └── register-commands.sh   # one-shot: register slash commands with Telegram
├── launchd/
│   ├── com.example.tgclaude.plist           # template → your copy
│   ├── com.example.tgclaude-watchdog.plist  # template → your copy
│   ├── run.example.sh     # template → run.sh: sources your secrets, execs bun run bot.ts
│   └── watchdog.example.sh # template → watchdog.sh: stat-checks heartbeat mtime
├── test/                  # unit + integration tests, bun test
├── persona.md             # base persona: mechanics + register (personality-light)
├── persona-voice.md       # spoken-aside register card
├── mcp-config.example.json # MCP template
├── tsconfig.json
├── Dockerfile             # for hermetic test runs
└── docker-compose.yml     # `docker compose run --rm test`
```

Module graph has zero cycles. `outbox` and `scratchpad` take their telegram dependencies via injection so they're testable without a real bot. Pure helpers (`format`, `state`, `heartbeat`) have zero imports beyond core.

---

## Setup

Requires Bun (`curl -fsSL https://bun.sh/install | bash`), Claude Code CLI, and a Telegram bot token from [@BotFather](https://t.me/BotFather).

```bash
git clone <this repo>
cd tgclaude
bun install

# Required env:
export TGCLAUDE_BOT_TOKEN="<from BotFather>"
export TGCLAUDE_BOT_CHAT_ID="<your numeric chat id>"

# Optional (enables voice):
export ELEVENLABS_API_KEY="<your key>"
export TGCLAUDE_VOICE_ID="<voice id from elevenlabs.io>"

# Run it:
bun run bot.ts
```

The bot is authorized for a single chat id by design - it's a personal surface with full machine agency when unlocked, not a public bot.

For permanent running on macOS, the `launchd/` directory ships `.example` versions of both plists and the run/watchdog shell scripts. The rendered host-specific versions are `.gitignore`d. Set yours up once:

```bash
cd launchd
cp com.example.tgclaude.plist           com.<YOUR_DOMAIN>.tgclaude.plist
cp com.example.tgclaude-watchdog.plist  com.<YOUR_DOMAIN>.tgclaude-watchdog.plist
cp run.example.sh                       run.sh
cp watchdog.example.sh                  watchdog.sh
# edit the four files: replace /Users/YOUR_USERNAME and com.YOUR_DOMAIN
cp com.<YOUR_DOMAIN>.*.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.<YOUR_DOMAIN>.tgclaude.plist
launchctl load ~/Library/LaunchAgents/com.<YOUR_DOMAIN>.tgclaude-watchdog.plist
```

---

## Make it yours: persona

The repo ships a deliberately personality-light base persona (`persona.md`): brevity rules, Telegram formatting, attachment/outbox/voice mechanics, the lock contract. Your bot's actual identity lives in a local overlay the repo never sees:

| What | Where | Notes |
|---|---|---|
| Base persona (ships in repo) | `persona.md` | Mechanics + neutral register. Hot-reloaded on every spawn. |
| Persona overlay (yours) | `~/.config/tgclaude/persona.local.md` | Appended after the base at spawn time and wins on conflict. Name, personality, your projects, memory guidance, anything operator-specific. |
| Voice-aside card (ships in repo) | `persona-voice.md` | Register for the one-line spoken acks and spoken TL;DRs. |
| Voice-aside card (yours) | `~/.config/tgclaude/persona-voice.local.md` | Fully replaces the repo card when present. |
| MCP servers (yours) | `~/.config/tgclaude/mcp-config.json` | Resolution: env `TGCLAUDE_MCP_CONFIG` → config dir → repo `.example.json`. |

`~/.config/tgclaude/` is created on first need; the bot doesn't fail without it (all overlays are optional).

Want your bot to be a butler, a ship computer, a wizard, a golden retriever? Write it in `persona.local.md`. The base file stays generic so upstream updates never fight your identity.

**Memory** is bring-your-own: attach a memory MCP server in your mcp-config, tell the persona overlay how to use it, and list its read-only tools in `TGCLAUDE_LOCKED_MCP_TOOLS` so recall works in locked mode.

---

## Env reference

| Var | Default | What |
|---|---|---|
| `TGCLAUDE_BOT_TOKEN` | required | BotFather token |
| `TGCLAUDE_BOT_CHAT_ID` | required | The single authorized chat id |
| `TGCLAUDE_DEFAULT_MODEL` | `claude-opus-4-8` | Baseline model; `/model` overrides per session |
| `TGCLAUDE_MCP_CONFIG` | config-dir / example | Path to MCP config JSON |
| `TGCLAUDE_LOCKED_MCP_TOOLS` | empty | Comma-separated MCP tools allowed in locked mode |
| `TGCLAUDE_CONFIG_DIR` | `~/.config/tgclaude` | Overlay + mcp-config home |
| `TGCLAUDE_STATE_DIR` | `~/.tgclaude` | Session/state/outbox/heartbeat home |
| `TGCLAUDE_DAILY_COST_USD` | `20` | Daily spend soft cap (warn once, keep serving) |
| `TGCLAUDE_SHOW_TELEMETRY` | `true` | Cost/context footer on replies |
| `TGCLAUDE_REACTIONS` | `true` | 👀/👍/😱 status reactions |
| `TGCLAUDE_STREAM_REPLY` | `true` | Live reply streaming into the scratchpad message |
| `TGCLAUDE_STREAM_MIN_CHARS` | `240` | Don't open a stream preview for short replies |
| `TGCLAUDE_COMPACT_TOKEN_THRESHOLD` | `120000` | Auto-compact trigger |
| `TGCLAUDE_COMPACT_COOLDOWN_TURNS` | `5` | Min turns between compactions |
| `ELEVENLABS_API_KEY` | optional | Enables voice transcription + TTS |
| `TGCLAUDE_VOICE_ID` | optional | Default ElevenLabs voice for TTS |
| `TGCLAUDE_VOICE_ACK_ENABLED` | `true` | Spoken one-line ack on voice memos |
| `TGCLAUDE_VOICE_ASIDE_MODEL` | `claude-haiku-4-5` | Fast model for voice asides |

Legacy `ALBUS_*` names (this project's original branding) are still read as a fallback when the `TGCLAUDE_*` name is unset, and legacy state/config dirs (`~/.albus-tg-bot`, `~/.config/albus`) are used when present. New installs should use the new names.

---

## Test it

```bash
bun test               # all tests
bun test format        # one file
bunx tsc --noEmit      # type-check pass

docker compose run --rm test       # hermetic, no host state touched
docker compose run --rm typecheck  # tsc in a container
```

---

## Slash commands

| Command | What it does |
|---|---|
| `/reset` or `/new` | Clear the Claude session; next message starts a fresh thread (long-term memory unaffected) |
| `/unlock` | Switch to full tools (Bash, Edit, Write, MCP writes). Replies append a "still unlocked" reminder. |
| `/lock` or `/relock` | Back to read-only safe mode |
| `/session` or `/status` | Print current session id, mode, and stats (turns, context, cost, age) |
| `/model` | Show or switch the session model (`/model opus\|sonnet\|haiku`, `/model default`) |
| `/compact` | Queue a manual compaction pass |
| `/help` | List commands |

---

## Why this exists

1. **A Claude agent on your phone is materially more useful than a Claude agent in a terminal you can't reach from the couch.** Couch-coding is the headline use case.
2. **The interesting work isn't Telegram, it's the per-turn outbox + persona injection + lock contract.** That pattern generalizes to Discord, Slack, voice, anywhere with a message bus.
3. **It's the smallest possible test bed for the "lots of agents in one room" architecture.** Same skeleton; swap the transport and multiple personas can share a channel.

---

## Status

Personal infrastructure, genericized. MIT-friendly if you fork it; not currently soliciting issues. Single-chat-id authorization is a design choice, not a limitation.
