#!/usr/bin/env bash
# Generate importable macOS Shortcut files (.shortcut) that drive the `lcp`
# controller via a "Run Shell Script" action.
#
# These are deliberately NOT auto-imported: adding a .shortcut opens the
# Shortcuts app and requires a genuine user "Add Shortcut" click (and the
# resulting shortcut must be granted shell/automation permission by macOS).
#
# The Full/YOLO shortcut is intentionally NOT generated: `lcp on --mode full`
# requires an interactive "YES" confirmation that a Shortcut cannot provide
# meaningfully, so Full mode stays Terminal-only.
set -euo pipefail

OUT_DIR="${1:-shortcuts}"
mkdir -p "$OUT_DIR"

emit() {
  # emit <filename> <shortcut-name> <shell-script-text>
  local file="$1" name="$2" script="$3"
  # XML-escape the embedded shell script (&, <, >) so the plist stays valid.
  script="$(printf '%s' "$script" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
  cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowActions</key>
  <array>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.runshellscript</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFShellEventParameters</key>
        <array/>
        <key>WFShellScriptText</key>
        <string>$script</string>
        <key>WFShowOutput</key>
        <true/>
      </dict>
    </dict>
  </array>
  <key>WFWorkflowClientVersion</key><string>2600.0.3</string>
  <key>WFWorkflowImportQuestions</key><array/>
  <key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
  <key>WFWorkflowName</key><string>$name</string>
  <key>WFWorkflowTypes</key>
  <array><string>NCWidget</string><string>WatchKit</string></array>
</dict>
</plist>
PLIST
  plutil -lint "$file" >/dev/null || { echo "invalid plist: $file" >&2; return 1; }
  echo "generated: $file"
}

# Notification helpers for Toggle/Status output.
NOTIFY_ON='osascript -e '"'"'display notification "Local ChatGPT Plus is ON" with title "Local ChatGPT Plus"'"'"''
NOTIFY_OFF='osascript -e '"'"'display notification "Local ChatGPT Plus is OFF" with title "Local ChatGPT Plus"'"'"''

TOGGLE_SCRIPT='
OUT=$("$HOME/.local/bin/lcp" toggle 2>&1); RC=$?
if [ $RC -eq 0 ] && printf "%s" "$OUT" | grep -q "ON"; then
  '"$NOTIFY_ON"'
elif [ $RC -eq 0 ] && printf "%s" "$OUT" | grep -q "OFF"; then
  '"$NOTIFY_OFF"'
else
  osascript -e "display notification \"Local ChatGPT Plus: ${OUT//\"/}\" with title \"Local ChatGPT Plus\""
fi
exit 0'

STATUS_SCRIPT='
OUT=$("$HOME/.local/bin/lcp" status 2>&1)
STATE=$(printf "%s" "$OUT" | awk -F"State:" '"'"'{print $2}'"'"' | head -1 | tr -d " ")
osascript -e "display notification \"Local ChatGPT Plus state: $STATE\" with title \"Local ChatGPT Plus\""
printf "%s\n" "$OUT"
exit 0'

emit "$OUT_DIR/Local ChatGPT Plus — ON.shortcut" "Local ChatGPT Plus — ON" '$HOME/.local/bin/lcp on'
emit "$OUT_DIR/Local ChatGPT Plus — OFF.shortcut" "Local ChatGPT Plus — OFF" '$HOME/.local/bin/lcp off'
emit "$OUT_DIR/Local ChatGPT Plus — Toggle.shortcut" "Local ChatGPT Plus — Toggle" "$TOGGLE_SCRIPT"
emit "$OUT_DIR/Local ChatGPT Plus — Status.shortcut" "Local ChatGPT Plus — Status" "$STATUS_SCRIPT"
# Projects Shortcut uses the dedicated mode switch: `lcp on --mode projects`
# now refuses to relabel an already-running server (Issue A), so switching to
# Projects from an already-ON Workspace/Full state requires `lcp mode projects`.
emit "$OUT_DIR/Local ChatGPT Plus — Projects.shortcut" "Local ChatGPT Plus — Projects" '$HOME/.local/bin/lcp mode projects'

echo "Done. Import by double-clicking each .shortcut and choosing 'Add Shortcut'."
echo "Full/YOLO mode intentionally has NO shortcut (Terminal-only): lcp on --mode full"