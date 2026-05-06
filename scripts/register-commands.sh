#!/bin/bash
# Register the bot's slash commands with Telegram so they show up in the
# native "/" autocomplete menu and the Menu button.
#
# Run this any time the command surface changes (add/remove/rename) or
# rerun verbatim to refresh descriptions.
#
# Requires ARGYLE_BOT_TOKEN in env (sourced from ~/.exports).
#
# Source of truth for what's available is the slash-command switch in
# bot.mjs. Keep this list in sync with that switch's canonical names.

set -euo pipefail

if [[ -z "${ARGYLE_BOT_TOKEN:-}" ]]; then
  echo "ARGYLE_BOT_TOKEN not set. Source ~/.exports first." >&2
  exit 1
fi

curl -sf -X POST "https://api.telegram.org/bot${ARGYLE_BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command": "unlock", "description": "Unlock to full tools (Bash, Edit, Write)"},
      {"command": "lock", "description": "Re-lock to read-only safe mode"},
      {"command": "status", "description": "Show session id and current mode"},
      {"command": "reset", "description": "Clear session, start fresh thread"},
      {"command": "help", "description": "List commands"}
    ]
  }' | python3 -m json.tool
