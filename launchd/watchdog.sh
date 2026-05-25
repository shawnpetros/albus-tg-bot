#!/bin/bash
# Watchdog for albus-tg-bot. Runs every 60s via its own launchd job.
# Reads the heartbeat file mtime; if the bot hasn't stamped it within
# the stale threshold, force-restarts the bot via launchctl kickstart.
#
# This catches "alive but stuck" failures that the main launchd's
# KeepAlive cannot detect: the bot process is up, but its poll loop
# has wedged on a hung socket or infinite retry. Crash restarts are
# already handled by the bot's own plist (KeepAlive.Crashed=true).

set -eo pipefail

HEARTBEAT_FILE="$HOME/.albus-tg-bot/heartbeat"
STALE_SECS=90
BOT_LABEL="com.shawnpetros.albus-tg-bot"
LOG="$HOME/.albus-tg-bot/watchdog.log"

log() {
  echo "[$(date '+%F %T')] $*" >> "$LOG"
}

# If heartbeat doesn't exist yet (fresh install, first boot), give the
# bot a grace period. Skip without acting.
if [[ ! -f "$HEARTBEAT_FILE" ]]; then
  log "no heartbeat file yet, skipping"
  exit 0
fi

# stat -f %m returns mtime as Unix epoch on macOS. Linux would need %Y.
MTIME=$(stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
NOW=$(date +%s)
AGE=$((NOW - MTIME))

if (( AGE > STALE_SECS )); then
  log "heartbeat stale (${AGE}s old, threshold ${STALE_SECS}s), restarting bot"
  if launchctl kickstart -k "gui/$(id -u)/${BOT_LABEL}" >> "$LOG" 2>&1; then
    log "kickstart issued OK"
  else
    log "kickstart failed (exit $?)"
  fi
else
  # Healthy. No log to avoid filling disk; uncomment for debugging.
  # log "heartbeat fresh (${AGE}s)"
  :
fi
