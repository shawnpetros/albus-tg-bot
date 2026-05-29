#!/bin/bash
set -eo pipefail
# Source your secrets here so the bot sees ALBUS_BOT_TOKEN, ALBUS_BOT_CHAT_ID,
# ELEVENLABS_API_KEY, etc. Point this at wherever you keep them, e.g.:
#   source "$HOME/.albus.env"
if [[ -f "$HOME/.albus.env" ]]; then
  set +u
  source "$HOME/.albus.env"
  set -u
fi
cd "$HOME/projects/albus-tg-bot"
# Bun runs TypeScript natively; bot.ts is the entry point that loads
# persona, ensures state dirs, and starts the poll loop in lib/poll.ts.
exec /opt/homebrew/bin/bun run bot.ts
