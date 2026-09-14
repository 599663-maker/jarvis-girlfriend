#!/bin/zsh
# Keeps "嗨 Jarvis" working on this Mac.
#
# The app's own autostart plist only has RunAtLoad, so a crash would leave the
# machine deaf until the app is opened again. This script is started by launchd
# and runs every 20 seconds:
#
#   1. Jarvis running  → nothing to do.
#   2. Jarvis gone     → make sure a lone wake listener is on the microphone,
#                        so the wake word works even while the app is closed.
#   3. Jarvis gone and it was NOT closed on purpose → open it again (crash
#      recovery). A deliberate close writes ~/.jarvis-codex/closed-by-user and
#      is never undone here: only saying "嗨 Jarvis" brings that Jarvis back.
#
# Create ~/.jarvis-codex/disabled to switch the keeper off completely.
set -u

app="${JARVIS_APP:-/Applications/Jarvis Codex.app}"
home="${HOME:-/Users/$(/usr/bin/id -un)}"
state_dir="$home/.jarvis-codex"
listener="$app/Contents/Resources/wake-helper/JarvisWakeListener.app"

if [[ -f "$state_dir/disabled" || ! -d "$app" ]]; then
  exit 0
fi
if /usr/bin/pgrep -x jarvis-codex >/dev/null 2>&1; then
  exit 0
fi

# Nothing is listening while the app is away (its conversation listener dies
# with it), so start the wake-only listener that just opens Jarvis again.
if [[ -d "$listener" ]] && ! /usr/bin/pgrep -x JarvisWakeListener >/dev/null 2>&1; then
  /usr/bin/open -n "$listener" --args --host-app "$app"
  print -r -- "$(/bin/date '+%Y-%m-%dT%H:%M:%S') wake listener started (app closed)" >> "$state_dir/keeper.log"
fi

# Closed on purpose (voice, menu or a signal): never re-open it here.
if [[ -f "$state_dir/closed-by-user" ]]; then
  exit 0
fi

/usr/bin/open -a "$app" --args --background
print -r -- "$(/bin/date '+%Y-%m-%dT%H:%M:%S') reopened $app" >> "$state_dir/keeper.log"
