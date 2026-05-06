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
cd "$HOME/projects/argyle-tg-bot"
exec /opt/homebrew/bin/node bot.mjs
