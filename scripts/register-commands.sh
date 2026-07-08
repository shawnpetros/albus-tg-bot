#!/bin/bash
# Register the bot's slash commands with Telegram so they show up in the
# native "/" autocomplete menu and the Menu button.
#
# Run this any time the command surface changes (add/remove/rename) or
# rerun verbatim to refresh descriptions.
#
# Requires TGCLAUDE_BOT_TOKEN in env.
#
# Source of truth for what's available is the slash-command router in
# lib/slash.ts. Keep this list in sync with that router's canonical names.

set -euo pipefail

if [[ -z "${TGCLAUDE_BOT_TOKEN:-}" ]]; then
  echo "TGCLAUDE_BOT_TOKEN not set." >&2
  exit 1
fi

curl -sf -X POST "https://api.telegram.org/bot${TGCLAUDE_BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command": "unlock", "description": "Unlock to full tools (Bash, Edit, Write)"},
      {"command": "lock", "description": "Re-lock to read-only safe mode"},
      {"command": "status", "description": "Show session id and current mode"},
      {"command": "model", "description": "Show or set the Claude model"},
      {"command": "compact", "description": "Summarize and shrink the session context"},
      {"command": "reset", "description": "Clear session, start fresh thread"},
      {"command": "help", "description": "List commands"}
    ]
  }' | python3 -m json.tool
