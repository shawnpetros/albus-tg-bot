#!/bin/bash
set -eo pipefail
if [[ -f "$HOME/.exports" ]]; then
  set +u
  # Source the secrets bundle that .exports re-exports from
  if [[ -f "$HOME/dotfiles/secrets/.env" ]]; then
    source "$HOME/dotfiles/secrets/.env"
  fi
  source "$HOME/.exports"
  set -u
fi
cd "$HOME/projects/albus-tg-bot"
# Bun runs TypeScript natively; bot.ts is the entry point that loads
# persona, ensures state dirs, and starts the poll loop in lib/poll.ts.
exec /opt/homebrew/bin/bun run bot.ts
