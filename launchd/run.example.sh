#!/bin/bash
set -eo pipefail
# Source your secrets here so the bot sees TGCLAUDE_BOT_TOKEN, TGCLAUDE_BOT_CHAT_ID,
# ELEVENLABS_API_KEY, etc. Point this at wherever you keep them, e.g.:
#   source "$HOME/.tgclaude.env"
if [[ -f "$HOME/.tgclaude.env" ]]; then
  set +u
  source "$HOME/.tgclaude.env"
  set -u
fi
cd "$HOME/projects/tgclaude"
# Bun runs TypeScript natively; bot.ts is the entry point that loads
# persona, ensures state dirs, and starts the poll loop in lib/poll.ts.
exec /opt/homebrew/bin/bun run bot.ts
